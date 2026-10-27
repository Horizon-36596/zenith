// A stand-in for the GitHub CLI in the desktop e2e tests (issue #213), run by the app with its own
// Node when ZENITH_TEST_GH names this file under ZENITH_HEADLESS=1. It answers exactly the one
// command Zenith runs, `gh auth token --hostname github.com`, with a made-up token, or as a signed-out
// CLI when FAKE_GH_SIGNED_OUT is set. Anything else is an error, so a test fails loudly if Zenith ever
// asks gh for something else.
const args = process.argv.slice(2).join(" ");
if (args !== "auth token --hostname github.com") {
  process.stderr.write(`fake gh: unexpected arguments: ${args}\n`);
  process.exit(9);
}
if (process.env.FAKE_GH_SIGNED_OUT === "1") {
  process.stderr.write("no oauth token found for github.com\n");
  process.exit(1);
}
process.stdout.write("gho_FAKEe2eTOKEN0123456789abcdefghij\n");
