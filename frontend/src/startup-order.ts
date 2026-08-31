export async function startApp(
  initializeRefresh: () => Promise<void>,
  initializeOnboarding: () => Promise<void>,
): Promise<void> {
  await initializeRefresh();
  await initializeOnboarding();
}
