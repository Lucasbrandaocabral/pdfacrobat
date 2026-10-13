// Hook afterPack do electron-builder: sem certificado da Apple, aplica uma
// assinatura ad-hoc ao app do macOS. Sem ela, Macs com chip Apple (arm64)
// mostram o app como "danificado" e se recusam a abri-lo.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
