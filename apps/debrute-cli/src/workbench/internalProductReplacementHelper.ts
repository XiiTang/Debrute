import { createRequire } from 'node:module';

type ProductReplacementHelperModule = {
  runProductReplacementHelper?: (planPath: string) => Promise<void>;
};

export async function runInternalProductReplacementHelper(
  replacementHelperPath = process.argv[3],
  planPath = process.argv[4]
): Promise<void> {
  if (!replacementHelperPath || !planPath) {
    throw new Error('Internal product replacement helper requires helper path and plan path.');
  }
  const requireFromCli = createRequire(import.meta.url);
  const helper = requireFromCli(replacementHelperPath) as ProductReplacementHelperModule;
  if (typeof helper.runProductReplacementHelper !== 'function') {
    throw new Error(`Product replacement helper does not export runProductReplacementHelper: ${replacementHelperPath}`);
  }
  await helper.runProductReplacementHelper(planPath);
}
