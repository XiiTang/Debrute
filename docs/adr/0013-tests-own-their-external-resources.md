# Tests Own Their External Resources

Integration and system tests own isolated homes, temporary Projects, listeners,
and the exact process IDs they create, and their awaited disposal must prove
process exit and port release. This was chosen over fixed sleeps, retries,
process-name searches, and platform cleanup commands so local tests have the
same deterministic lifecycle on macOS, Windows, and Linux without affecting a
user's existing runtime.
