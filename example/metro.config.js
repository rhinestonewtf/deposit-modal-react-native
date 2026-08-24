const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

/**
 * Everything resolves from this app's `node_modules`, and only from there.
 *
 * The package is linked, and it carries its own `react`, `react-native` and
 * `react-native-webview` to typecheck and test against — they are peers of the
 * published package, not dependencies. Resolving from where the package's files
 * physically live would give the app a second React Native, and it dies at
 * startup on `TurboModuleRegistry.getEnforcing('PlatformConstants')`: a missing
 * native module, naming neither the duplicate nor this file.
 */
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
