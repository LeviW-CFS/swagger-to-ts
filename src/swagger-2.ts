import * as prettier from 'prettier';
import { camelCase, capitalize, sanitize, spacesToUnderscores } from './utils';

export interface Swagger2Definition {
  $ref?: string;
  allOf?: Swagger2Definition[];
  description?: string;
  enum?: string[];
  format?: string;
  items?: Swagger2Definition;
  oneOf?: Swagger2Definition[];
  properties?: { [index: string]: Swagger2Definition };
  additionalProperties?: boolean | Swagger2Definition;
  required?: string[];
  type?: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
  // use this construct to allow arbitrary x-something properties. Must be any,
  // since we have no idea what they might be
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface Property {
  interfaceType: string;
  optional: boolean;
  description?: string;
}

export interface Swagger2 {
  swagger?: string;
  openapi?: string;
  definitions: {
    [index: string]: Swagger2Definition;
  };
}

export interface Swagger2Options {
  camelcase?: boolean;
  propertyMapper?: (swaggerDefinition: Swagger2Definition, property: Property) => Property;
  warning?: boolean;
  wrapper?: string | false;
}

export const warningMessage = `/**
 * This file was auto-generated by swagger-to-ts.
 * Do not make direct changes to the file.
 */
`;

const PRIMITIVE: { [index: string]: string } = {
  string: 'string',
  integer: 'number',
  number: 'number',
};

function parse(spec: Swagger2, options: Swagger2Options = {}): string {
  const shouldUseWrapper = options.wrapper !== false;
  const wrapper =
    typeof options.wrapper === 'string' && options.wrapper
      ? options.wrapper
      : 'declare namespace OpenAPI2';
  const shouldCamelCase = options.camelcase || false;

  const queue: [string, Swagger2Definition][] = [];

  const output: string[] = [];

  if (options.warning !== false) {
    output.push(warningMessage);
  }

  if (wrapper && shouldUseWrapper) {
    output.push(`${wrapper} {`);
  }

  const { definitions } = spec;

  function getRef(lookup: string): [string, Swagger2Definition] {
    const ID = lookup.replace('#/definitions/', '');
    const ref = definitions[ID];
    return [ID, ref];
  }

  // Returns primitive type, or 'object' or 'any'
  function getType(
    definition: Swagger2Definition,
    nestedName: string,
    getTypeOptions: { camelcase: boolean }
  ): string {
    const { $ref, items, type, ...value } = definition;

    const nextInterface = camelCase(nestedName); // if this becomes an interface, it’ll need to be camelCased

    const DEFAULT_TYPE = 'object';

    if ($ref) {
      const [refName, refProperties] = getRef($ref);
      let convertedRefName = spacesToUnderscores(refName);
      if (options && options.camelcase === true) {
        convertedRefName = camelCase(convertedRefName);
      }
      // If a shallow array interface, return that instead
      if (refProperties.items && refProperties.items.$ref) {
        return getType(refProperties, refName, getTypeOptions);
      }
      if (refProperties.type && PRIMITIVE[refProperties.type]) {
        return PRIMITIVE[refProperties.type];
      }
      return convertedRefName || DEFAULT_TYPE;
    }

    if (items && items.$ref) {
      const [refName] = getRef(items.$ref);
      return `ReadonlyArray<${getType(items, refName, getTypeOptions)}>`;
    }

    if (items) {
      // if an array, keep nesting
      if (items.type === 'array') {
        return `ReadonlyArray<${getType(items, nestedName, getTypeOptions)}>`;
      }
      // else if primitive, return type
      if (items.type && PRIMITIVE[items.type]) {
        return `ReadonlyArray<${PRIMITIVE[items.type]}>`;
      }
      // otherwise if this is an array of nested types, return that interface for later
      queue.push([nextInterface, items]);
      return `ReadonlyArray<${nextInterface}>`;
    }

    if (Array.isArray(value.oneOf)) {
      return value.oneOf.map((def): string => getType(def, '', getTypeOptions)).join(' | ');
    }

    if (value.properties) {
      // If this is a nested object, let’s add it to the stack for later
      queue.push([nextInterface, { $ref, items, type, ...value }]);
      return nextInterface;
    }

    if (type) {
      return PRIMITIVE[type] || type || DEFAULT_TYPE;
    }

    return DEFAULT_TYPE;
  }

  function handleAdditionalProperties(additionalProperties: boolean | Swagger2Definition): string {
    if ((additionalProperties as Swagger2Definition).type) {
      const interfaceType = getType(additionalProperties as Swagger2Definition, '', {
        camelcase: shouldCamelCase,
      });
      return `[key: string]: ${interfaceType}`;
    }

    return '[key: string]: any;';
  }

  function buildNextInterface(): void {
    const nextObject = queue.pop();
    if (!nextObject) return; // Geez TypeScript it’s going to be OK
    const [ID, { allOf, properties, required, additionalProperties, type }] = nextObject;

    let allProperties = properties || {};
    const includes: string[] = [];

    // Include allOf, if specified
    if (Array.isArray(allOf)) {
      allOf.forEach((item): void => {
        // Add “implements“ if this references other items
        if (item.$ref) {
          const [refName] = getRef(item.$ref);
          includes.push(refName);
        } else if (item.properties) {
          allProperties = { ...allProperties, ...item.properties };
        }
      });
    }

    // If nothing’s here, let’s skip this one.
    if (
      !Object.keys(allProperties).length &&
      additionalProperties !== true &&
      type &&
      PRIMITIVE[type]
    ) {
      return;
    }
    // Open interface
    const isExtending = includes.length ? ` extends ${includes.join(', ')}` : '';

    output.push(
      `export interface ${
        shouldCamelCase ? camelCase(ID) : spacesToUnderscores(ID)
      }${isExtending} {`
    );

    // Populate interface
    Object.entries(allProperties).forEach(([key, value]): void => {
      const formattedKey = shouldCamelCase ? camelCase(key) : key;
      const newID = `${ID}${capitalize(formattedKey)}`;
      const interfaceType = Array.isArray(value.enum)
        ? ` ${value.enum.map(option => JSON.stringify(option)).join(' | ')}` // Handle enums in the same definition
        : getType(value, newID, { camelcase: shouldCamelCase });

      let property: Property = {
        interfaceType,
        optional: !Array.isArray(required) || required.indexOf(key) === -1,
        description: value.description,
      };
      property = options.propertyMapper ? options.propertyMapper(value, property) : property;

      const name = `${sanitize(formattedKey)}${property.optional ? '?' : ''}`;

      if (typeof property.description === 'string') {
        // Print out descriptions as jsdoc comments, but only if there’s something there (.*)
        output.push(`/**\n* ${property.description.replace(/\n$/, '').replace(/\n/g, '\n* ')}\n*/`);
      }

      if (value.additionalProperties) {
        output.push(
          `readonly ${name}: { ${handleAdditionalProperties(value.additionalProperties)} }`
        );
      } else {
        output.push(`readonly ${name}: ${interfaceType};`);
      }
    });

    if (additionalProperties) {
      output.push(handleAdditionalProperties(additionalProperties));
    }

    // Close interface
    output.push('}');
  }

  // Begin parsing top-level entries
  Object.entries(definitions).forEach((entry): void => {
    const value = entry[1];
    // start with objects only
    const isObject = value.type === 'object';
    const isAssumedObject = !value.type;
    if (isObject || isAssumedObject) {
      queue.push(entry);
    }
  });
  queue.sort((a, b) => a[0].localeCompare(b[0]));
  while (queue.length > 0) {
    buildNextInterface();
  }

  if (wrapper && shouldUseWrapper) {
    output.push('}'); // Close namespace
  }

  return prettier.format(output.join('\n'), { parser: 'typescript' });
}

export default parse;
