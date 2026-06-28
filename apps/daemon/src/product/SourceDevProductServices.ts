import { createOfficialDebruteSkillsMaterializer } from '@debrute/capability-runtime';
import type { ManagedCliDiagnostic } from '@debrute/app-protocol';
import type {
  DebruteManagedCliService,
  DebruteProductServices
} from '../http/createDebruteDaemonHttpServer.js';
import { ProductUpdateService } from './ProductUpdateService.js';

export interface SourceDevProductServicesInput {
  productVersion: string;
  cliPath: string;
  skillsPayloadDir: string;
  userHome?: string;
}

const SOURCE_DEV_PRODUCT_ENV = {
  productVersion: 'DEBRUTE_DAEMON_PRODUCT_VERSION',
  cliPath: 'DEBRUTE_DAEMON_CLI_PATH',
  skillsPayloadDir: 'DEBRUTE_DAEMON_SKILLS_PAYLOAD_DIR'
} as const;

export function createSourceDevProductServices(input: SourceDevProductServicesInput): DebruteProductServices {
  const managedCli = new SourceDevManagedCliService(input);
  return {
    managedCli,
    productUpdate: new ProductUpdateService({
      productVersion: input.productVersion,
      cliDiagnostic: () => managedCli.diagnostic(),
      releaseSource: async () => null
    })
  };
}

export function createSourceDevProductServicesFromEnv(env: NodeJS.ProcessEnv): DebruteProductServices {
  const values = {
    productVersion: env[SOURCE_DEV_PRODUCT_ENV.productVersion],
    cliPath: env[SOURCE_DEV_PRODUCT_ENV.cliPath],
    skillsPayloadDir: env[SOURCE_DEV_PRODUCT_ENV.skillsPayloadDir]
  };
  const missing = Object.entries(values)
    .filter(([, value]) => value === undefined || value === '')
    .map(([key]) => SOURCE_DEV_PRODUCT_ENV[key as keyof typeof SOURCE_DEV_PRODUCT_ENV]);
  if (missing.length > 0) {
    throw new Error(`Source dev product services require ${missing.join(', ')}.`);
  }
  return createSourceDevProductServices(values as SourceDevProductServicesInput);
}

class SourceDevManagedCliService implements DebruteManagedCliService {
  private lastDiagnostic: ManagedCliDiagnostic;

  constructor(private readonly input: SourceDevProductServicesInput) {
    this.lastDiagnostic = {
      status: 'error',
      version: input.productVersion,
      path: input.cliPath,
      message: 'Source Debrute product services have not materialized Skills yet.'
    };
  }

  async ensureCurrent(): Promise<ManagedCliDiagnostic> {
    try {
      const skillsStatus = await createOfficialDebruteSkillsMaterializer({
        payloadSkillsRoot: this.input.skillsPayloadDir,
        debruteVersion: this.input.productVersion,
        ...(this.input.userHome !== undefined ? { userHome: this.input.userHome } : {})
      }).materialize();
      this.lastDiagnostic = {
        status: 'ready',
        version: this.input.productVersion,
        path: this.input.cliPath,
        skillsVersion: skillsStatus.currentDebruteVersion,
        skillsRoot: skillsStatus.sharedSkillsRoot
      };
    } catch (error) {
      this.lastDiagnostic = {
        status: 'error',
        version: this.input.productVersion,
        path: this.input.cliPath,
        message: errorMessage(error)
      };
    }
    return this.lastDiagnostic;
  }

  diagnostic(): ManagedCliDiagnostic {
    return this.lastDiagnostic;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
