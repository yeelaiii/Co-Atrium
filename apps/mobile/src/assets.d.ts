// Static assets loaded through Metro's asset system (metro.config.js assetExts).
declare module '*.html' {
  const asset: number;
  export default asset;
}
