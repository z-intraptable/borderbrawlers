/** Lectura de `--clave valor` y `--clave=valor`. Sin dependencias. */

export function flag(argv: string[], name: string, fallback: string): string {
  const long = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === long) return argv[i + 1] ?? fallback;
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
  }
  return fallback;
}

export function numberFlag(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name, '');
  if (raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
