import * as AWS from 'aws-sdk';
import { sleep } from '../aws';

const COLLECT_BY_TAG = 'collect-by';
const REPO_LIFETIME_MS = 24 * 3600 * 1000; // One day

export class TestRepository {
  public static readonly DEFAULT_DOMAIN = 'test-cdk';

  public static async newRandom() {
    const qualifier = Math.random().toString(36).replace(/[^a-z0-9]+/g, '');

    const repo = new TestRepository(`test-${qualifier}`);
    await repo.prepare();
    return repo;
  }

  public static async newWithName(name: string) {
    const repo = new TestRepository(name);
    await repo.prepare();
    return repo;
  }

  public static existing(repositoryName: string) {
    return new TestRepository(repositoryName);
  }

  /**
   * Garbage collect repositories
   */
  public static async gc() {
    if (!await TestRepository.existing('*dummy*').domainExists()) {
      return;
    }

    const codeArtifact = new AWS.CodeArtifact();

    let nextToken: string | undefined;
    do {
      const page = await codeArtifact.listRepositories({ nextToken }).promise();

      for (const repo of page.repositories ?? []) {
        const tags = await codeArtifact.listTagsForResource({ resourceArn: repo.arn! }).promise();
        const collectable = tags?.tags?.find(t => t.key === COLLECT_BY_TAG && Number(t.value) < Date.now());
        if (collectable) {
          // eslint-disable-next-line no-console
          console.log('Deleting', repo.name);
          await codeArtifact.deleteRepository({
            domain: repo.domainName!,
            repository: repo.name!,
          }).promise();
        }
      }

      nextToken = page.nextToken;
    } while (nextToken);
  }

  public readonly npmUpstream = 'npm-upstream';
  public readonly pypiUpstream = 'pypi-upstream';
  public readonly nugetUpstream = 'nuget-upstream';
  public readonly mavenUpstream = 'maven-upstream';
  public readonly domain = TestRepository.DEFAULT_DOMAIN;

  private readonly codeArtifact = new AWS.CodeArtifact();

  private constructor(public readonly repositoryName: string) {
  }

  public async prepare() {
    await this.ensureDomain();
    await this.ensureUpstreams();

    await this.ensureRepository(this.repositoryName, {
      description: 'Testing repository',
      upstreams: [
        this.npmUpstream,
        this.pypiUpstream,
        this.nugetUpstream,
        this.mavenUpstream,
      ],
      tags: {
        [COLLECT_BY_TAG]: `${Date.now() + REPO_LIFETIME_MS}`,
      },
    });
  }

  public async loginInformation(): Promise<LoginInformation> {
    return {
      authToken: (await this.codeArtifact.getAuthorizationToken({ domain: this.domain, durationSeconds: 12 * 3600 }).promise()).authorizationToken!,
      repositoryName: this.repositoryName,
      npmEndpoint: (await this.codeArtifact.getRepositoryEndpoint({ domain: this.domain, repository: this.repositoryName, format: 'npm' }).promise()).repositoryEndpoint!,
      mavenEndpoint: (await this.codeArtifact.getRepositoryEndpoint({ domain: this.domain, repository: this.repositoryName, format: 'maven' }).promise()).repositoryEndpoint!,
      nugetEndpoint: (await this.codeArtifact.getRepositoryEndpoint({ domain: this.domain, repository: this.repositoryName, format: 'nuget' }).promise()).repositoryEndpoint!,
      pypiEndpoint: (await this.codeArtifact.getRepositoryEndpoint({ domain: this.domain, repository: this.repositoryName, format: 'pypi' }).promise()).repositoryEndpoint!,
    };
  }

  public async delete() {
    try {
      await this.codeArtifact.deleteRepository({
        domain: this.domain,
        repository: this.repositoryName,
      }).promise();

      // eslint-disable-next-line no-console
      console.log('Deleted', this.repositoryName);
    } catch (e) {
      if (e.code !== 'ResourceNotFoundException') { throw e; }
      // Okay
    }
  }

  private async ensureDomain() {
    if (await this.domainExists()) { return; }
    await this.codeArtifact.createDomain({
      domain: this.domain,
      tags: [{ key: 'testing', value: 'true' }],
    }).promise();
  }

  private async ensureUpstreams() {
    await this.ensureRepository(this.npmUpstream, {
      description: 'The upstream repository for NPM',
      external: 'public:npmjs',
    });
    await this.ensureRepository(this.mavenUpstream, {
      description: 'The upstream repository for Maven',
      external: 'public:maven-central',
    });
    await this.ensureRepository(this.nugetUpstream, {
      description: 'The upstream repository for NuGet',
      external: 'public:nuget-org',
    });
    await this.ensureRepository(this.pypiUpstream, {
      description: 'The upstream repository for PyPI',
      external: 'public:pypi',
    });
  }

  private async ensureRepository(name: string, options?: {
    readonly description?: string,
    readonly external?: string,
    readonly upstreams?: string[],
    readonly tags?: Record<string, string>,
  }) {
    if (await this.repositoryExists(name)) { return; }

    await this.codeArtifact.createRepository({
      domain: this.domain,
      repository: name,
      description: options?.description,
      upstreams: options?.upstreams?.map(repositoryName => ({ repositoryName })),
      tags: options?.tags ? Object.entries(options.tags).map(([key, value]) => ({ key, value })) : undefined,
    }).promise();

    if (options?.external) {
      const externalConnection = options.external;
      await retry(() => this.codeArtifact.associateExternalConnection({
        domain: this.domain,
        repository: name,
        externalConnection,
      }).promise());
    }
  }

  private async domainExists() {
    try {
      await this.codeArtifact.describeDomain({ domain: this.domain }).promise();
      return true;
    } catch (e) {
      if (e.code !== 'ResourceNotFoundException') { throw e; }
      return false;
    }
  }

  private async repositoryExists(name: string) {
    try {
      await this.codeArtifact.describeRepository({ domain: this.domain, repository: name }).promise();
      return true;
    } catch (e) {
      if (e.code !== 'ResourceNotFoundException') { throw e; }
      return false;
    }
  }
}

async function retry<A>(block: () => Promise<A>) {
  let attempts = 3;
  while (true) {
    try {
      return await block();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug(e.message);
      if (attempts-- === 0) { throw e; }
      await sleep(500);
    }
  }
}
export interface LoginInformation {
  readonly authToken: string;
  readonly repositoryName: string;
  readonly npmEndpoint: string;
  readonly mavenEndpoint: string;
  readonly nugetEndpoint: string;
  readonly pypiEndpoint: string;
}