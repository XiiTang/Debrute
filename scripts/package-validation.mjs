import AdmZip from 'adm-zip';

export function validateZipEntries(zipPath, requiredEntries) {
  const zip = new AdmZip(zipPath);
  const entries = new Set(zip.getEntries().map((entry) => entry.entryName.replaceAll('\\', '/')));
  for (const requiredEntry of requiredEntries) {
    if (!entries.has(requiredEntry)) {
      throw new Error(`Package archive is missing required entry: ${requiredEntry}`);
    }
  }
}
