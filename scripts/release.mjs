import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Tag and package version differ');
const output = path.resolve(process.env.AGENT_NOTE_RELEASE_DIR || 'release');
await fs.mkdir(output, { recursive: true });
const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))[0];
const hash = createHash('sha256').update(await fs.readFile(path.join(output, result.filename))).digest('hex');
await fs.writeFile(path.join(output, 'SHA256SUMS'), `${hash}  ${result.filename}\n`);
const formula = `class AgentNoteCli < Formula
  desc "Review your AI coding day with the Agent Notebook backend"
  homepage "https://github.com/WdBlink/agent-note-cli"
  url "https://github.com/WdBlink/agent-note-cli/releases/download/v${pkg.version}/${result.filename}"
  sha256 "${hash}"
  license "MIT"

  depends_on "node"

  def install
    # Production dependencies are bundled and checksummed with the release.
    ENV["npm_config_offline"] = "true"
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agent-note --version")
    (testpath/"codex").mkpath
    transcript = testpath/"codex/session.jsonl"
    transcript.write [
      { type: "session_meta", payload: { id: "brew-test", cwd: testpath.to_s } },
      { type: "response_item", timestamp: "2026-08-29T12:00:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review fixture" }] } },
    ].map(&:to_json).join("\\n")
    File.utime(Time.utc(2026, 8, 29, 12), Time.utc(2026, 8, 29, 12), transcript)
    output = shell_output("#{bin}/agent-note brief --date 2026-08-29 --timezone UTC " \\
                          "--root #{testpath}/codex --source codex --data-dir #{testpath}/data " \\
                          "--read-only --format json")
    result = JSON.parse(output)
    assert_equal "raw", result.fetch("mode")
    assert_equal "brew-test", result.fetch("sessions").first.fetch("id")
    assert_nil result.fetch("index")
  end
end
`;
await fs.writeFile(path.join(output, 'agent-note-cli.rb'), formula);
console.log(`${result.filename} · ${result.size} bytes · sha256 ${hash}`);
