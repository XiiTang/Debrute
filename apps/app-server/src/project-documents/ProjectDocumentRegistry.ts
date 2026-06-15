export type ProjectDocumentRole = 'source' | 'pushed' | 'metadata' | 'cache';

export interface ProjectDocumentDescriptor {
  type: string;
  pathPattern: string;
  role: ProjectDocumentRole;
  owners: readonly string[];
  matches(projectRelativePath: string): boolean;
}

export class ProjectDocumentRegistry {
  constructor(readonly descriptors: ProjectDocumentDescriptor[]) {}

  descriptorForPath(projectRelativePath: string): ProjectDocumentDescriptor | undefined {
    const normalized = projectRelativePath.replaceAll('\\', '/');
    return this.descriptors.find((descriptor) => descriptor.matches(normalized));
  }
}
