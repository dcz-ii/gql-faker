import {
  buildSchema,
  getNamedType,
  isLeafType,
  isAbstractType,
  GraphQLAbstractType,
  GraphQLOutputType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLEnumType,
  GraphQLScalarType,
  GraphQLLeafType,
} from 'graphql';

import * as fs from 'fs';
import * as _ from 'lodash';
import * as faker from 'faker';
import * as express from 'express';
import * as graphqlHTTP from 'express-graphql';

interface GraphQLAppliedDiretives {
  isApplied(directiveName: string): boolean;
  getAppliedDirectives(): Array<string>;
  getDirectiveArgs(directiveName: string): { [argName: string]: any };
}

const userIDL = fs.readFileSync('./schema.graphql', 'utf-8');

const idl = `
enum Fake__Types {
  address_zipCode
  address_city
  address_cityPrefix
  address_citySuffix
  address_streetName
  address_streetAddress
  address_streetSuffix
  address_streetPrefix
  address_secondaryAddress
  address_county
  address_country
  address_countryCode
  address_state
  address_stateAbbr
  address_latitude
  address_longitude
}
directive @fake(type:Fake__Types!) on FIELD_DEFINITION
` + userIDL;

const typeFakers = {
  'Int': {
    defaultOptions: {min: 0, max: 99999},
    generator: (options) => {
      options.precision = 1;
      return () => faker.random.number(options);
    }
  },
  'Float': {
    defaultOptions: {min: 0, max: 99999, precision: 0.01},
    generator: (options) => {
      return () => faker.random.number(options);
    }
  },
  'String': {
    defaultOptions: {},
    generator: (options) => {
      return () => 'string';
    }
  },
  'Boolean': {
    defaultOptions: {},
    generator: (options) => {
      return () => faker.random.boolean();
    }
  },
  'ID': {
    defaultOptions: {},
    generator: (options) => {
      return () =>
        new Buffer(
          faker.random.number({max: 9999999999}).toString()
        ).toString('base64');
    }
  },
};
const stdTypeNames = Object.keys(typeFakers);

function getRandomInt(min:number, max:number) {
  return faker.random.number({min, max});
}

function getRandomItem(array:any[]) {
  return array[getRandomInt(0, array.length - 1)];
}

type FakeArgs = {
  type:string
};

const schema = buildSchema(idl);

_.each(schema.getTypeMap(), type => {
  if (type instanceof GraphQLScalarType && !stdTypeNames.includes(type.name))
    type.serialize = (value => value);
  if (type instanceof GraphQLObjectType && !type.name.startsWith('__'))
    addFakeProperties(type);
  if (isAbstractType(type))
    type.resolveType = (obj => obj.__typename);
});

function addFakeProperties(objectType:GraphQLObjectType) {
  _.each(objectType.getFields(), field => {
    const directives = field['appliedDirectives'] || null  as GraphQLAppliedDiretives;
    const type = field.type as GraphQLOutputType;
    return field.resolve = getResolver(type, directives);
  });
}

function fakeValue(fakeArgs:FakeArgs):() => string {
  const [category, generator] = fakeArgs.type.split('_');
  return faker[category][generator];
}

function getResolver(type:GraphQLOutputType, directives) {
  if (type instanceof GraphQLNonNull)
    return getResolver(type.ofType, directives);
  if (type instanceof GraphQLList)
    return arrayResolver(getResolver(type.ofType, directives));
  if (isAbstractType(type))
    return abstractTypeResolver(type);
  if (isLeafType(type))
    return getLeafResolver(type, directives);
  return () => {};
}

function abstractTypeResolver(type:GraphQLAbstractType) {
  const possibleTypes = schema.getPossibleTypes(type);
  return () => ({__typename: getRandomItem(possibleTypes)});
}

function arrayResolver(itemResolver) {
  return (...args) => {
    let length = getRandomInt(2, 4);
    const result = [];

    while (length-- !== 0)
      result.push(itemResolver(...args));
    return result;
  }
}

function getLeafResolver(type:GraphQLLeafType, directives) {
  const fakeArgs = directives && directives.getDirectiveArgs('fake');

  if (fakeArgs)
    return fakeValue(fakeArgs);

  if (type instanceof GraphQLEnumType) {
    const values = type.getValues().map(x => x.value);
    return () => getRandomItem(values);
  }

  const typeFaker = typeFakers[type.name];
  if (typeFaker)
    return typeFaker.generator(typeFaker.defaultOptions);
  else
    return () => `<${type.name}>`;
}

const app = express();

app.use('/graphql', graphqlHTTP({
  schema,
  graphiql: true
}));
app.listen(9002);

console.log('http://localhost:9002/graphql');
