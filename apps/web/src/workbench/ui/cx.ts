type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]): string | undefined {
  const className = values.filter(Boolean).join(' ');
  return className || undefined;
}
