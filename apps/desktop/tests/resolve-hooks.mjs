// Lets `node --experimental-strip-types` resolve the app's extensionless relative imports (`'../tasks/delegate-task'`).
export async function resolve(specifier, context, next) {
    try {
        return await next(specifier, context);
    } catch (error) {
        const relative =
            specifier.startsWith('./') || specifier.startsWith('../');
        if (
            error.code === 'ERR_MODULE_NOT_FOUND' &&
            relative &&
            !/\.[cm]?[jt]s$/.test(specifier)
        ) {
            return next(`${specifier}.ts`, context);
        }
        throw error;
    }
}
