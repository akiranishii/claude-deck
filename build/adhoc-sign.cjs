// electron-builder afterPack hook: apply an ad-hoc code signature to the packed .app.
// Apple Silicon refuses to run binaries whose signature no longer matches the bundle, and this
// local build is not signed with a Developer ID. Ad-hoc signing keeps it runnable on this Mac.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${app}`)
}
