#!/usr/bin/env node

import {
  Source,
  parse,
  concatAST,
  buildASTSchema,
} from 'graphql';

import * as fs from 'fs';
import * as path from 'path';
import * as express from 'express';
import * as graphqlHTTP from 'express-graphql';
import chalk from 'chalk';
import * as opn from 'opn';
import * as cors from 'cors';
import * as bodyParser from 'body-parser';
import { pick } from 'lodash';
import * as yargs from 'yargs';

import { fakeSchema } from './fake_schema';
import { proxyMiddleware } from './proxy';
import { existsSync } from './utils';

const argv = yargs
  .usage('$0 [file]')
  .options({
    'port': {
      alias: 'p',
      describe: 'HTTP Port',
      type: 'number',
      requiresArg: true,
      default: process.env.PORT || 9002,
    },
    'open': {
      alias: 'o',
      describe: 'Open page with SDL editor and GraphiQL in browser',
      type: 'boolean',
    },
    'cors-origin': {
      alias: 'co',
      describe: 'CORS: Specify the custom origin for the Access-Control-Allow-Origin header, by default it is the same as `Origin` header from the request',
      type: 'string',
      requiresArg: true,
      default: true,
    },
    'extend': {
      alias: 'e',
      describe: 'URL to existing GraphQL server to extend',
      type: 'string',
      requiresArg: true,
    },
    'header': {
      alias: 'H',
      describe: 'Specify headers to the proxied server in cURL format, e.g.: "Authorization: bearer XXXXXXXXX"',
      array: true,
      type: 'string',
      requiresArg: true,
      implies: 'extend',
      coerce(arr) {
        const headers = {};
        for (const str of arr) {
          const [, name, value] = str.match(/(.*?):(.*)/);
          headers[name.toLowerCase()] = value.trim();
        }
        return headers;
      },
    },
    'forward-headers': {
      describe: 'Specify which headers should be forwarded to the proxied server',
      array: true,
      type: 'string',
      implies: 'extend',
      coerce(arr) {
        return arr.map(str => str.toLowerCase());
      },
    },
  })
  .strict()
  .help('h')
  .alias('h', 'help')
  .epilog(`Examples:

  # Mock GraphQL API based on example SDL and open interactive editor
  $0 --open

  # Extend real data from SWAPI with faked data based on extension SDL
  $0 ./ext-swapi.grqphql --extend http://swapi.apis.guru/

  # Extend real data from GitHub API with faked data based on extension SDL
  $0 ./ext-gh.graphql --extend https://api.github.com/graphql \\
  --header "Authorization: bearer <TOKEN>"`)
  .argv

const log = console.log;

let fileName = argv.file as string | undefined;
if (!fileName) {
  fileName = argv.extend
    ? './schema_extension.faker.graphql'
    : './schema.faker.graphql';
  log(chalk.yellow(`Default file ${chalk.magenta(fileName)} is used. ` +
  `Specify [file] parameter to change.`));
}

// different default SDLs for extend and non-extend modes
const defaultFileName = argv.extend ? 'default-extend.graphql' : 'default-schema.graphql';
let userSDL = existsSync(fileName)
  ? readSDL(fileName)
  : readSDL(path.join(__dirname, defaultFileName));

const fakeDefinitionAST = readAST(path.join(__dirname, 'fake_definition.graphql'));

if (argv.extend) {
  // run in proxy mode
  const url = argv.extend;
  proxyMiddleware(url, argv.headers)
    .then(([schemaSDL, cb]) => {
      schemaSDL = new Source(schemaSDL, `Inrospection from "${url}"`);
      runServer(schemaSDL, userSDL, cb)
    })
    .catch(error => {
      log(chalk.red(error.stack));
      process.exit(1);
    });
} else {
  runServer(userSDL, null, schema => {
    fakeSchema(schema)
    return {schema};
  });
}

function runServer(schemaSDL: Source, extensionSDL: Source, optionsCB) {
  const app = express();

  if (extensionSDL) {
    const schema = buildServerSchema(schemaSDL);
    extensionSDL.body = extensionSDL.body.replace('<RootTypeName>', schema.getQueryType().name);
  }

  const corsOptions = {
    credentials: true,
    origin: argv['cors-origin'],
  };
  app.options('/graphql', cors(corsOptions))
  app.use('/graphql', cors(corsOptions), graphqlHTTP(req => {
    const schema = buildServerSchema(schemaSDL);
    const forwardHeaders = pick(req.headers, argv['forward-headers']);
    return {
      ...optionsCB(schema, extensionSDL, forwardHeaders),
      graphiql: true,
    };
  }));

  app.get('/user-sdl', (_, res) => {
    res.status(200).json({
      schemaSDL: schemaSDL.body,
      extensionSDL: extensionSDL && extensionSDL.body,
    });
  });

  app.use('/user-sdl', bodyParser.text({limit: '8mb'}));

  app.post('/user-sdl', (req, res) => {
    try {
      fs.writeFileSync(fileName, req.body);
      const newSDL = new Source(req.body, fileName);
      if (extensionSDL === null)
        schemaSDL = newSDL;
      else
        extensionSDL = newSDL;
      log(`${chalk.green('✚')} schema saved to ${chalk.magenta(fileName)} on ${(new Date()).toLocaleString()}`);

      res.status(200).send('ok');
    } catch(err) {
      res.status(500).send(err.message)
    }
  });

  app.use('/editor', express.static(path.join(__dirname, 'editor')));

  const server = app.listen(argv.port);

  const shutdown = () => {
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`\n${chalk.green('✔')} Your GraphQL Fake API is ready to use 🚀
  Here are your links:

  ${chalk.blue('❯')} Interactive Editor:\t http://localhost:${argv.port}/editor
  ${chalk.blue('❯')} GraphQL API:\t http://localhost:${argv.port}/graphql

  `);

  if (argv.open) {
    setTimeout(() => opn(`http://localhost:${argv.port}/editor`), 500);
  }
}

function readSDL(filepath) {
  return new Source(
    fs.readFileSync(filepath, 'utf-8'),
    filepath
  );
}

function readAST(filepath) {
  return parse(readSDL(filepath));
}

function buildServerSchema(sdl) {
  var ast = concatAST([parse(sdl), fakeDefinitionAST]);
  return buildASTSchema(ast);
}
