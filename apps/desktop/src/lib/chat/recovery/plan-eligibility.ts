/** Whether a provider's observed plan satisfies an optional exact-name allow-list. */
export function matchesAllowedPlan(
    plan: string | null | undefined,
    allowedPlans: readonly string[],
): boolean {
    if (allowedPlans.length === 0) return true;
    if (!plan?.trim()) return false;
    const observed = plan.trim().toLowerCase();
    return allowedPlans.some(
        (allowed) => allowed.trim().toLowerCase() === observed,
    );
}
