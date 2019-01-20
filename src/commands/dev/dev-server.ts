import fs from 'fs';
import path from 'path';
import http from 'http';

// @ts-ignore
import glob from '@now/build-utils/fs/glob';
import chalk from 'chalk';
import { send } from 'micro';
// @ts-ignore
import { createFunction } from '../../../../lambdas/lambda-dev';

import wait from '../../util/output/wait';
import info from '../../util/output/info';
import error from '../../util/output/error';
import success from '../../util/output/success';
import { NowError } from '../../util/now-error';
import { readLocalConfig } from '../../util/config/files';

import builderCache from './builder-cache';

interface BuildConfig {
  src: string,
  use: string,
  config?: object
}

interface RouteConfig {
  src: string,
  dest: string,
  methods?: string[],
  headers?: object,
  status?: number
}

interface BuilderOutput {
  type?: string,
  zipBuffer?: any,
  handler?: string,
  runtime?: string,
  environment?: string
}

interface BuilderOutputs {
  [key: string]: BuilderOutput
}

enum DevServerStatus { busy, idle, error }

type HttpHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => any;

export default class DevServer {
  private cwd: string;
  private server: http.Server;
  private status: DevServerStatus;
  private statusMessage = '';
  private builderDirectory = '';

  constructor (cwd: string, port = 3000) {
    this.cwd = cwd;
    this.server = http.createServer(this.devServerHandler);
    this.builderDirectory = builderCache.prepare();
    this.status = DevServerStatus.busy;
  }

  /* use dev-server as a "console" for logs. */
  logInfo (str: string) { console.log(info(str)) }
  logError (str: string) { console.log(error(str)) }
  logSuccess (str: string) { console.log(success(str))}
  logHttp (msg?: string) {
    msg && console.log(`\n  ${chalk.green('>>>')} ${msg}\n`);
  }

  start = async (port = 3000) => {
    const nowJson = readLocalConfig(this.cwd);

    return new Promise((resolve, reject) => {
      this.server.on('error', reject);

      this.server.listen(port, async () => {
        this.logSuccess(
          `dev server listning on port ${chalk.bold(String(port))}`
        );

        // Initial build, not meant to invoke, but for speed up further builds.
        if (nowJson && nowJson.builds) {
          try {
            this.setStatusBusy('installing builders');
            await this.installBuilders(nowJson.builds);

            this.setStatusBusy('building lambdas');
            await this.buildLambdas(nowJson.builds);
          } catch (err) {
            reject(err);
          }
        }

        this.logSuccess('ready');
        this.setStatusIdle();
        resolve();
      });
    })
  }

  setStatusIdle = () => {
    this.status = DevServerStatus.idle;
    this.statusMessage = '';
  }

  setStatusBusy = (msg = '') => {
    this.status = DevServerStatus.busy;
    this.statusMessage = msg;
  }

  setStatusError = (msg: string) => {
    this.status = DevServerStatus.error;
    this.statusMessage = msg;
  }

  devServerHandler:HttpHandler = async (req, res) => {
    if (this.status === DevServerStatus.busy) {
      return res.end(`[busy] ${this.statusMessage}...`);
    }

    if (req.url === '/favicon.ico') {
      return res.end('');
    }

    this.logHttp(req.url);

    try {
      const nowJson = readLocalConfig(this.cwd);

      if (nowJson === null) {
        await this.serveStatics(req, res, this.cwd);
      } else if (nowJson.builds) {
        await this.serveBuilds(req, res, this.cwd, nowJson);
      }
    } catch (err) {
      this.setStatusError(err.message);
      console.error(err.stack);
    }

    if (!res.finished) {
      send(res, 500, this.statusMessage);
    }

    this.setStatusIdle();
  }

  /**
   * Serve project directory as static
   */
  serveStatics = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cwd: string
  ) => {
    if (req.url === undefined) {
      return send(res, 404);
    }

    // TODO: honor gitignore & nowignore
    const dest = path.join(cwd, req.url.replace(/^\//, ''));

    if (fs.lstatSync(dest).isFile()) {
      return send(res, 200, fs.createReadStream(dest));
    }

    return send(res, 404);
  }

  /**
   * Build & invoke project
   */
  serveBuilds = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cwd: string,
    nowJson: any
  ) => {
    const assets = await this.buildUserProject(nowJson.builds);

    const {
      type,
      zipBuffer,
      handler,
      runtime,
      environment
    } = this.route(req, assets, nowJson.routes)

    console.log(999, type, handler, runtime);

    if (type === 'Lambda') {
      const fn = await createFunction({
        Code: { zipFile: zipBuffer },
        Handler: handler,
        Runtime: runtime,
        Environment: environment
      });

      const invoked = await fn({
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({
          method: req.method,
          path: req.url,
          headers: req.headers,
          encoding: 'base64',
          body: 'eyJlaXlvIjp0cnVlfQ=='
        })
      })

      console.log(invoked);
    }
  }

  /**
   * Find the handler responsible for the request
   */
  route = function (
    req: http.IncomingMessage,
    assets: BuilderOutputs,
    routes?: RouteConfig[]
  ) {
    if (req.url === undefined) return {}

    let reqDest = req.url.replace(/^\//, '');

    if (routes) {
      reqDest = routes.reduce((accu: string, curr:RouteConfig) => {
        if (curr.dest) {
          return accu.replace(new RegExp('^' + curr.src + '$'), curr.dest);
        } else {
          return accu;
        }
      }, reqDest);
    }

    const foundHandler = matchHandler(assets, reqDest)

    return foundHandler || {}
  }

  buildUserProject = async (buildsConfig: BuildConfig[]) => {
    try {
      this.setStatusBusy('installing builders');
      await this.installBuilders(buildsConfig);

      this.setStatusBusy('building lambdas');
      const assets = await this.buildLambdas(buildsConfig);

      this.setStatusIdle();
      return assets;
    } catch (err) {
      throw new Error('Build failed.');
    }
  }

  installBuilders = async (buildsConfig: BuildConfig[]) => {
    const builders = buildsConfig
      .map(build => build.use)
      .filter(pkg => pkg !== '@now/static')
      .concat('@now/build-utils');

    for (const builder of builders) {
      const stopSpinner = wait(`pulling ${builder}`);
      await builderCache.install(this.builderDirectory, builder);
      stopSpinner();
    }
  }

  buildLambdas = async (buildsConfig: BuildConfig[]) => {
    const files = await glob('**', this.cwd);
    let results = {};

    for (const build of buildsConfig) {
      try {
        console.log(`> build ${JSON.stringify(build)}`);

        const entries = Object.values(await glob(build.src, this.cwd));
        const builder = builderCache.get(this.builderDirectory, build.use);

        // TODO: hide those build logs from console.
        for (const entry of entries) {
          const output = await builder.build({
            files,
            // @ts-ignore: handle this warning later.
            entrypoint: path.relative(this.cwd, entry.fsPath),
            workPath: this.cwd,
            config: build.config
          });
          results = {...results, ...output};
        }
      } catch (err) {
        throw new NowError({
          code: 'NOW_BUILDER_FAILURE',
          message: `Failed building ${chalk.bold(build.src)} with ${build.use}`,
          meta: err.stack
        });
      }
    }

    return results;
  }
}

function matchHandler (assets: BuilderOutputs, url: string) {
  return assets[url]
      || assets[url + "index.js"]
      || assets[url + "/index.js"]
      || assets[url + "/index.html"];
}
