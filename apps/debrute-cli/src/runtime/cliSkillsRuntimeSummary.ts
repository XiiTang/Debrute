import type {
  DebruteAgentCommandResult,
  DebruteAgentFieldValue,
  DebruteAgentNamedRecord,
  SkillsStatusSnapshot
} from '@debrute/app-protocol';

export function addCliSkillsToRuntimeStatus(
  result: DebruteAgentCommandResult,
  snapshot: SkillsStatusSnapshot
): DebruteAgentCommandResult {
  if (result.status !== 'ok') {
    return result;
  }
  return {
    ...result,
    fields: {
      ...(result.fields ?? {}),
      skills: snapshot.skills.length,
      diagnostics: numericField(result.fields?.diagnostics, 'diagnostics') + snapshot.diagnostics.length
    }
  };
}

export function addCliSkillsToRuntimeDoctor(
  result: DebruteAgentCommandResult,
  snapshot: SkillsStatusSnapshot
): DebruteAgentCommandResult {
  if (result.status !== 'ok') {
    return result;
  }
  const records = [
    ...(result.records ?? []),
    ...skillsDoctorDiagnosticRecords(snapshot)
  ];
  return {
    ...result,
    records,
    fields: {
      ...(result.fields ?? {}),
      diagnostics: records.length
    }
  };
}

export function skillsDoctorDiagnosticRecords(snapshot: SkillsStatusSnapshot): DebruteAgentNamedRecord[] {
  const diagnostics: DebruteAgentNamedRecord[] = snapshot.diagnostics.map((diagnostic) => ({
    name: 'diagnostic',
    fields: {
      code: diagnostic.code,
      severity: diagnostic.severity === 'error' ? 'error' : 'warning',
      message: skillsDoctorMessage(diagnostic.code, diagnostic.message)
    }
  }));
  if (
    snapshot.state?.debruteVersion
    && snapshot.state.debruteVersion !== snapshot.currentDebruteVersion
  ) {
    diagnostics.push({
      name: 'diagnostic',
      fields: {
        code: 'skills_out_of_sync',
        severity: 'warning',
        message: `Debrute Skills ${snapshot.state.debruteVersion} out of sync with Debrute CLI ${snapshot.currentDebruteVersion}. Run: debrute skills sync`
      }
    });
  }
  if (snapshot.skills.length === 0) {
    diagnostics.push({
      name: 'diagnostic',
      fields: {
        code: 'skills_not_installed',
        severity: 'warning',
        message: 'No Debrute-managed Skills are installed. Run: debrute skills sync.'
      }
    });
  }
  return diagnostics;
}

function skillsDoctorMessage(code: string, fallback: string): string {
  if (code === 'skills_bundle_unavailable') {
    return 'Bundled Debrute Skills are unavailable. Reinstall Debrute CLI or run from a complete development checkout.';
  }
  return fallback;
}

function numericField(value: DebruteAgentFieldValue | undefined, name: string): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== 'number') {
    throw new Error(`Runtime CLI bridge returned non-numeric ${name}.`);
  }
  return value;
}
