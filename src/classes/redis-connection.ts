import { EventEmitter } from 'events';
import * as IORedis from 'ioredis';
import * as semver from 'semver';
import { load } from '../commands';
import { ConnectionOptions, RedisOptions } from '../interfaces';
import { isRedisInstance } from '../utils';
import { ClusterNode, ClusterOptions } from 'ioredis';

export type RedisClient = IORedis.Redis | IORedis.Cluster;
export type RedisGlobalConfig =
  | { single: RedisOptions }
  | { cluster: { nodes: ClusterNode[]; options?: ClusterOptions } };

let redisGlobalConfig: RedisGlobalConfig = {
  single: {
    port: 6379,
    host: '127.0.0.1',
    retryStrategy: function(times: number) {
      return Math.min(Math.exp(times), 20000);
    },
  },
};

export function setRedisGlobalConfig(value: RedisGlobalConfig) {
  redisGlobalConfig = value;
}

export class RedisConnection extends EventEmitter {
  static minimumVersion = '5.0.0';
  private _client: RedisClient;
  private initializing: Promise<RedisClient>;
  private closing: boolean;
  private version: string;

  constructor(private readonly opts?: ConnectionOptions) {
    super();

    if (!isRedisInstance(opts)) {
      if ('cluster' in redisGlobalConfig) {
        this._client = new IORedis.Cluster(redisGlobalConfig.cluster.nodes, {
          ...redisGlobalConfig.cluster.options,
          ...opts,
        });
      } else {
        this._client = new IORedis(redisGlobalConfig.single);
      }
    } else {
      this._client = <RedisClient>opts;
    }

    this.initializing = this.init();

    this.initializing
      .then(client => client.on('error', err => this.emit('error', err)))
      .catch(err => this.emit('error', err));
  }

  /**
   * Waits for a redis client to be ready.
   * @param {Redis} redis client
   */
  static async waitUntilReady(client: RedisClient) {
    return new Promise<void>(function(resolve, reject) {
      if (client.status === 'ready') {
        resolve();
      } else {
        async function handleReady() {
          client.removeListener('error', handleError);
          resolve();
        }

        function handleError(err: NodeJS.ErrnoException) {
          if (err['code'] !== 'ECONNREFUSED') {
            client.removeListener('ready', handleReady);
            reject(err);
          }
        }

        client.once('ready', handleReady);
        client.once('error', handleError);
      }
    });
  }

  get client(): Promise<RedisClient> {
    return this.initializing;
  }

  private async init() {
    const opts = this.opts as RedisOptions;
    await RedisConnection.waitUntilReady(this._client);
    await load(this._client);

    if (opts && opts.skipVersionCheck !== true && !this.closing) {
      this.version = await this.getRedisVersion();
      if (semver.lt(this.version, RedisConnection.minimumVersion)) {
        throw new Error(
          `Redis version needs to be greater than ${RedisConnection.minimumVersion} Current: ${this.version}`,
        );
      }
    }
    return this._client;
  }

  async disconnect() {
    const client = await this.client;
    if (client.status !== 'end') {
      let _resolve, _reject;

      const disconnecting = new Promise((resolve, reject) => {
        client.once('end', resolve);
        client.once('error', reject);
        _resolve = resolve;
        _reject = reject;
      });

      client.disconnect();

      try {
        await disconnecting;
      } finally {
        client.removeListener('end', _resolve);
        client.removeListener('error', _reject);
      }
    }
  }

  async reconnect() {
    const client = await this.client;
    return client.connect();
  }

  async close() {
    if (!this.closing) {
      this.closing = true;
      if (this.opts != this._client) {
        await this._client.quit();
      }
    }
  }

  private async getRedisVersion() {
    const doc = await this._client.info();
    const prefix = 'redis_version:';
    const lines = doc.split('\r\n');

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(prefix) === 0) {
        return lines[i].substr(prefix.length);
      }
    }
  }

  get redisVersion(): string {
    return this.version;
  }
}
