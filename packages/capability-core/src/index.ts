export interface ArtifactPointer {
  artifactId: string;
  available: boolean;
  projectRelativePath: string;
  title?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface ProjectArtifactPointerInput {
  artifactId: string;
  projectRelativePath: string;
  title?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export function projectArtifactPointer(artifact: ProjectArtifactPointerInput): ArtifactPointer {
  return {
    artifactId: artifact.artifactId,
    projectRelativePath: artifact.projectRelativePath,
    available: true,
    ...(artifact.title !== undefined ? { title: artifact.title } : {}),
    ...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
    ...(artifact.width !== undefined ? { width: artifact.width } : {}),
    ...(artifact.height !== undefined ? { height: artifact.height } : {})
  };
}

export function projectArtifactPointers(artifacts: ProjectArtifactPointerInput[]): ArtifactPointer[] {
  return artifacts.map(projectArtifactPointer);
}

export type AxisCapabilityResult =
  | {
      status: 'ok';
      outputs: Record<string, unknown>;
      artifacts?: ArtifactPointer[];
      logs?: Array<Record<string, unknown>>;
    }
  | {
      status: 'error';
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      outputs?: Record<string, unknown>;
      artifacts?: ArtifactPointer[];
      logs?: Array<Record<string, unknown>>;
    };

export function capabilityOk(
  outputs: Record<string, unknown>,
  options: { artifacts?: ArtifactPointer[]; logs?: Array<Record<string, unknown>> } = {}
): AxisCapabilityResult {
  return {
    status: 'ok',
    outputs,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.logs ? { logs: options.logs } : {})
  };
}

export function capabilityError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  options: { outputs?: Record<string, unknown>; artifacts?: ArtifactPointer[]; logs?: Array<Record<string, unknown>> } = {}
): AxisCapabilityResult {
  return {
    status: 'error',
    error: {
      code,
      message,
      ...(details ? { details } : {})
    },
    ...(options.outputs ? { outputs: options.outputs } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.logs ? { logs: options.logs } : {})
  };
}
