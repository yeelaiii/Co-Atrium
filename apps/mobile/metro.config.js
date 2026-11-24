const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// The deadline calculator and contract schemas live with the Edge Functions
// (apps/supabase/functions/_shared) and are imported here as @shared/*: one source of truth.
// Only the pure modules (deadlines/, contracts/, extraction/guards.ts) may be imported by the app.
const shared = path.resolve(__dirname, '../supabase/functions/_shared');
config.watchFolders = [...(config.watchFolders ?? []), shared];
config.resolver.extraNodeModules = { ...(config.resolver.extraNodeModules ?? {}), '@shared': shared };
// The bundled pdf.js source viewer (assets/pdf-viewer/viewer.html) is loaded as an asset.
config.resolver.assetExts = [...config.resolver.assetExts, 'html'];
// Shared files import bare packages (zod); resolve them from this app's node_modules.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules'), ...(config.resolver.nodeModulesPaths ?? [])];

module.exports = withNativeWind(config, { input: './global.css' });
