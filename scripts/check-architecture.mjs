import { architectureBoundaryViolations } from '@axis/architecture-rules';

const violations = await architectureBoundaryViolations(process.cwd());

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log('Architecture boundaries passed.');
