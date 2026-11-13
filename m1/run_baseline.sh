#!/usr/bin/env bash
# Baseline runner for the Switchboard M1 Gate 0 (t96u) on a fresh worktree. Local only, no deploy, no real services.
# Mirrors .github/workflows/ci.yml job steps (minus deploy and screenshots upload).
set -u
export PATH="$HOME/.local/node22/bin:$PATH"
unset JEV_API_KEY LIVE_GITHUB_TOKEN CLOUDFLARE_API_TOKEN GITHUB_TOKEN GH_TOKEN
export CI=true
R=$HOME/engineering-workspace/worktrees/switchboard-m1
L=$HOME/engineering-workspace/engineering-ops/projects/switchboard-m1/baseline_logs
S=$L/summary.tsv
echo -e "step\tcwd\tcmd\texit\tseconds\tstart_ct" > $S
run() { local name=$1 dir=$2; shift 2; local t0=$(date +%s); local st=$(date '+%F %T %Z')
  (cd "$R/$dir" && bash -c "$*") > "$L/$name.log" 2>&1; local ec=$?
  echo -e "$name\t$dir\t$*\t$ec\t$(( $(date +%s)-t0 ))\t$st" >> $S; echo "$name exit=$ec"; }
echo "node $(node -v) npm $(npm -v)" > $L/env.txt; uname -a >> $L/env.txt; git -C $R rev-parse HEAD >> $L/env.txt; git -C $R branch --show-current >> $L/env.txt
run 01_worker_ci worker "npm ci"
run 02_cli_ci cli "npm ci"
run 03_dashboard_ci dashboard "npm ci"
run 04_worker_typecheck worker "npm run typecheck"
run 05_worker_lint worker "npm run lint"
run 06_worker_test worker "npm test"
run 07_cli_typecheck cli "npm run typecheck"
run 08_cli_lint cli "npm run lint"
run 09_cli_test cli "npm test"
run 10_dashboard_lint dashboard "npm run lint"
run 11_dashboard_typecheck dashboard "npm run typecheck"
run 12_dashboard_build dashboard "npm run build"
run 13_dashboard_test dashboard "npm test"
run 14_dashboard_shots dashboard "timeout 900 npm run shots"
git -C $R status --porcelain > $L/git_status_after.txt
echo DONE >> $S
# Totals (parsed from vitest/shots output; never fabricated)
{ echo "== totals =="; for f in 06_worker_test 09_cli_test 13_dashboard_test; do echo "$f: $(grep -E '^ +Test Files' $L/$f.log | tail -1 | sed 's/  */ /g') |$(grep -E '^ +Tests ' $L/$f.log | tail -1 | sed 's/  */ /g')"; done; echo "shots: $(grep -E 'screenshots in' $L/14_dashboard_shots.log | tail -1)"; } > $L/totals.txt
cat $L/totals.txt
