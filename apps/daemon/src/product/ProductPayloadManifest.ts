export interface ProductPayloadManifest {
  schemaVersion: 1;
  productVersion: string;
}

export function parseProductPayloadManifest(value: unknown): ProductPayloadManifest {
  if (!isRecord(value)) {
    throw new Error('Product payload manifest must be an object.');
  }
  const manifest = {
    schemaVersion: value.schemaVersion,
    productVersion: value.productVersion
  };
  if (manifest.schemaVersion !== 1) {
    throw new Error('Product payload manifest schemaVersion must be 1.');
  }
  if (typeof manifest.productVersion !== 'string' || manifest.productVersion.trim() === '') {
    throw new Error('Product payload manifest productVersion must be a non-empty string.');
  }
  const pathFields = ['cliRoot', 'skillsRoot', 'webRoot', 'replacementHelper'].filter((key) => key in value);
  if (pathFields.length > 0) {
    throw new Error(`Product payload manifest must not declare path fields: ${pathFields.join(', ')}.`);
  }
  const unsupportedFields = Object.keys(value).filter((key) => key !== 'schemaVersion' && key !== 'productVersion');
  if (unsupportedFields.length > 0) {
    throw new Error(`Product payload manifest contains unsupported fields: ${unsupportedFields.join(', ')}.`);
  }
  return manifest as ProductPayloadManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
