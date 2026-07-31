#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

FORK_REPO=""
UPSTREAM_URL="https://github.com/getpaseo/paseo.git"
RELEASE_WORKFLOW_FILE="shasderias-release.yml"
RELEASE_WORKFLOW_NAME="Shasderias Release"
DISABLE_COMMIT_SUBJECT="chore(fork): disable upstream release automation"
STAMP_COMMIT_SUBJECT="feat(desktop): mark shasderias builds as customized"
AUTOMATION_COMMIT_SUBJECT="ci(fork): automate shasderias archive releases"
FUNCTIONAL_COMMIT_SUBJECT="fix(server): append standard ports (80, 443) to connection hint"

log() {
  printf '[shasderias] %s\n' "$*"
}

warn() {
  printf '[shasderias] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[shasderias] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./shasderias.sh <command> [arguments]

Commands:
  status
      Fetch upstream metadata and show the current fork base and customization stack.

  check-workflows
      Verify that only CI and the shasderias archive workflow are active.

  rebase <version>
      Rebase the customization stack from its current upstream release onto
      v<version>. Accepts either 0.2.6 or v0.2.6.

  verify [version]
      Run fork invariants, builds, formatting, linting, typechecking, and focused tests.

  release <version> [--revision N]
      Rebase, verify, force-with-lease push main, wait for CI, create the fork tag,
      wait for the archive workflow, and verify release assets. The first release is
      v<version>-shasderias; source-changing rebuilds use --revision 2 or higher.

  rebuild <version> [--revision N]
      Manually dispatch the archive workflow for an existing fork release tag.

  help
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is not available: $1"
}

initialize_fork_repo() {
  local url host path
  url=$(git remote get-url origin 2>/dev/null) || die "Remote origin is not configured"

  case "$url" in
    https://*|http://*)
      host=${url#*://}
      host=${host%%/*}
      path=${url#*://*/}
      ;;
    git@*:*)
      host=${url#git@}
      host=${host%%:*}
      path=${url#*:}
      ;;
    *) die "Unsupported origin URL: $url" ;;
  esac

  path=${path%.git}
  [[ "$path" == "shasderias/paseo" ]] ||
    die "origin points to $path, expected shasderias/paseo"
  FORK_REPO="$host/$path"
}

rebase_in_progress() {
  local git_dir
  git_dir=$(git rev-parse --git-dir)
  [[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]
}

ensure_main_branch() {
  if rebase_in_progress; then
    die "A rebase is already in progress; resolve it and run git rebase --continue, or abort it"
  fi
  local branch
  branch=$(git branch --show-current)
  [[ "$branch" == "main" ]] || die "Expected branch main, found ${branch:-detached HEAD}"
}

ensure_clean_worktree() {
  local status
  status=$(git status --porcelain)
  [[ -z "$status" ]] || {
    printf '%s\n' "$status" >&2
    die "Working tree must be clean"
  }
}

ensure_upstream_remote() {
  if git remote get-url upstream >/dev/null 2>&1; then
    local url
    url=$(git remote get-url upstream)
    [[ "$url" == "$UPSTREAM_URL" ]] ||
      die "Remote upstream points to $url, expected $UPSTREAM_URL"
  else
    log "Adding canonical upstream remote"
    git remote add upstream "$UPSTREAM_URL"
  fi
}

fetch_remotes() {
  ensure_upstream_remote
  log "Fetching upstream branches and tags"
  git fetch upstream --prune --tags --force
  log "Fetching origin"
  git fetch origin --prune
}

normalize_version() {
  local version=${1#v}
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "Unsupported version '$1'; expected a stable version such as 0.2.6"
  printf '%s\n' "$version"
}

package_version() {
  require_command node
  node -p "require('./package.json').version"
}

expected_node_version() {
  awk '$1 == "nodejs" { print $2; exit }' .tool-versions
}

ensure_pinned_node() {
  require_command node
  require_command npm
  require_command npx

  local expected actual
  expected=$(expected_node_version)
  actual=$(node -p 'process.versions.node')
  [[ "$actual" == "$expected" ]] ||
    die "Node $expected is required by .tool-versions; found $actual"
}

verify_workspace_versions() {
  local expected=$1
  EXPECTED_VERSION="$expected" node <<'NODE'
const fs = require("node:fs");
const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
const paths = ["package.json", ...root.workspaces.map((workspace) => `${workspace}/package.json`)];
const mismatches = [];
for (const packagePath of paths) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (pkg.version !== process.env.EXPECTED_VERSION) {
    mismatches.push(`${packagePath}: ${String(pkg.version)}`);
  }
}
if (mismatches.length > 0) {
  process.stderr.write(`Workspace versions do not all match ${process.env.EXPECTED_VERSION}:\n`);
  process.stderr.write(`${mismatches.join("\n")}\n`);
  process.exit(1);
}
NODE
  log "All workspace versions match $expected"
}

release_tag_for() {
  local version=$1
  local revision=$2
  if [[ "$revision" == "1" ]]; then
    printf 'v%s-shasderias\n' "$version"
  else
    printf 'v%s-shasderias.%s\n' "$version" "$revision"
  fi
}

parse_version_revision() {
  [[ $# -ge 1 ]] || die "A version is required"
  PARSED_VERSION=$(normalize_version "$1")
  PARSED_REVISION=1
  shift

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --revision)
        [[ $# -ge 2 ]] || die "--revision requires a number"
        PARSED_REVISION=$2
        shift 2
        ;;
      *) die "Unknown argument: $1" ;;
    esac
  done

  [[ "$PARSED_REVISION" =~ ^[0-9]+$ ]] || die "Revision must be an integer"
  (( PARSED_REVISION >= 1 )) || die "Revision must be at least 1"
}

latest_stable_upstream_tag() {
  git tag --merged upstream/main --list 'v[0-9]*' --sort=-version:refname |
    awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/ && !found { print; found = 1 }'
}

active_github_workflows() {
  find .github/workflows -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) \
    -printf '%f\n' | sort
}

active_eas_workflows() {
  if [[ -d packages/app/.eas/workflows ]]; then
    find packages/app/.eas/workflows -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) \
      -printf '%f\n' | sort
  fi
}

check_workflows() {
  local workflow unexpected=0
  local ci_found=0 release_found=0

  while IFS= read -r workflow; do
    [[ -n "$workflow" ]] || continue
    case "$workflow" in
      ci.yml) ci_found=1 ;;
      "$RELEASE_WORKFLOW_FILE") release_found=1 ;;
      *)
        printf '[shasderias] Unexpected active GitHub workflow: %s\n' "$workflow" >&2
        unexpected=1
        ;;
    esac
  done < <(active_github_workflows)

  (( ci_found == 1 )) || {
    warn "Required workflow .github/workflows/ci.yml is missing"
    unexpected=1
  }
  (( release_found == 1 )) || {
    warn "Required workflow .github/workflows/$RELEASE_WORKFLOW_FILE is missing"
    unexpected=1
  }

  while IFS= read -r workflow; do
    [[ -n "$workflow" ]] || continue
    printf '[shasderias] Unexpected active EAS workflow: %s\n' "$workflow" >&2
    unexpected=1
  done < <(active_eas_workflows)

  (( unexpected == 0 )) ||
    die "Workflow allowlist failed; disable new upstream automation before releasing"
  log "Workflow allowlist is valid"
}

disable_unwanted_workflows() {
  local path destination workflow

  while IFS= read -r workflow; do
    [[ -n "$workflow" ]] || continue
    case "$workflow" in
      ci.yml|"$RELEASE_WORKFLOW_FILE") continue ;;
    esac

    path=".github/workflows/$workflow"
    destination="$path.disabled"
    log "Disabling newly active GitHub workflow $workflow"
    if [[ -e "$destination" ]]; then
      git rm -f --ignore-unmatch "$destination" >/dev/null 2>&1 || rm -f "$destination"
    fi
    git mv "$path" "$destination"
  done < <(active_github_workflows)

  while IFS= read -r workflow; do
    [[ -n "$workflow" ]] || continue
    path="packages/app/.eas/workflows/$workflow"
    destination="$path.disabled"
    log "Disabling newly active EAS workflow $workflow"
    if [[ -e "$destination" ]]; then
      git rm -f --ignore-unmatch "$destination" >/dev/null 2>&1 || rm -f "$destination"
    fi
    git mv "$path" "$destination"
  done < <(active_eas_workflows)
}

find_unique_commit_by_subject() {
  local base=$1
  local subject=$2
  local matches count

  matches=$(git log --format='%H%x09%s' "$base..HEAD" |
    awk -F '\t' -v subject="$subject" '$2 == subject { print $1 }')
  count=$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')
  [[ "$count" == "1" ]] ||
    die "Expected exactly one '$subject' commit above $base, found $count"
  printf '%s\n' "$matches"
}

refresh_disabled_workflows() {
  local base=$1
  disable_unwanted_workflows

  if [[ -z $(git status --porcelain) ]]; then
    return
  fi

  local target
  target=$(find_unique_commit_by_subject "$base" "$DISABLE_COMMIT_SUBJECT")
  log "Folding newly disabled workflows into $DISABLE_COMMIT_SUBJECT"
  git add -A .github/workflows
  if [[ -d packages/app/.eas ]] || [[ -n $(git ls-files 'packages/app/.eas/*') ]]; then
    git add -A packages/app/.eas
  fi
  git -c core.hooksPath=/dev/null commit --fixup="$target"
  GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash "$base"
}

verify_custom_commit_stack() {
  local base=$1 subject index last_index=-1 found_index count
  local -a expected actual
  expected=(
    "$DISABLE_COMMIT_SUBJECT"
    "$STAMP_COMMIT_SUBJECT"
    "$AUTOMATION_COMMIT_SUBJECT"
    "$FUNCTIONAL_COMMIT_SUBJECT"
  )
  mapfile -t actual < <(git log --reverse --format='%s' "$base..HEAD")

  for subject in "${expected[@]}"; do
    count=0
    found_index=-1
    for index in "${!actual[@]}"; do
      if [[ "${actual[$index]}" == "$subject" ]]; then
        count=$((count + 1))
        found_index=$index
      fi
    done
    [[ "$count" == "1" ]] ||
      die "Expected exactly one '$subject' commit above $base, found $count"
    (( found_index > last_index )) ||
      die "Customization commit is out of order: $subject"
    last_index=$found_index
  done
  log "Required customization commits are present exactly once and in order"
}

cmd_status() {
  fetch_remotes
  local version base latest
  version=$(package_version)
  base="v$version"
  latest=$(latest_stable_upstream_tag)

  printf 'Branch:              %s\n' "$(git branch --show-current)"
  printf 'HEAD:                %s\n' "$(git rev-parse --short=12 HEAD)"
  printf 'Current base:        %s\n' "$base"
  printf 'Latest upstream:     %s\n' "${latest:-unknown}"
  printf 'Working tree:        %s\n' "$([[ -z $(git status --porcelain) ]] && echo clean || echo DIRTY)"
  printf '\nCustomization commits above %s:\n' "$base"
  git log --oneline "$base..HEAD"
  printf '\nActive GitHub workflows:\n'
  active_github_workflows | sed 's/^/  /'
  printf '\nActive EAS workflows:\n'
  if [[ -n $(active_eas_workflows) ]]; then
    active_eas_workflows | sed 's/^/  /'
  else
    printf '  (none)\n'
  fi
}

cmd_rebase() {
  [[ $# -eq 1 ]] || die "Usage: ./shasderias.sh rebase <version>"
  local target_version target_tag current_version current_tag backup
  target_version=$(normalize_version "$1")
  target_tag="v$target_version"

  ensure_main_branch
  ensure_clean_worktree
  fetch_remotes

  git rev-parse --verify "$target_tag^{commit}" >/dev/null 2>&1 ||
    die "Upstream release tag $target_tag does not exist"
  git merge-base --is-ancestor "$target_tag" upstream/main ||
    die "$target_tag is not an ancestor of upstream/main"

  current_version=$(package_version)
  current_tag="v$current_version"
  git rev-parse --verify "$current_tag^{commit}" >/dev/null 2>&1 ||
    die "Current package version does not identify a fetched upstream tag: $current_tag"
  git merge-base --is-ancestor "$current_tag" HEAD ||
    die "Current upstream base $current_tag is not an ancestor of main"
  git merge-base --is-ancestor "$current_tag" "$target_tag" ||
    die "Refusing to move backward or sideways from $current_tag to $target_tag"

  if [[ "$current_tag" != "$target_tag" ]]; then
    backup="backup/shasderias-${current_version}-before-${target_version}-$(date -u +%Y%m%dT%H%M%SZ)"
    git branch "$backup" HEAD
    log "Created safety branch $backup"
    log "Rebasing customization commits from $current_tag onto $target_tag"
    if ! git rebase --onto "$target_tag" "$current_tag" main; then
      warn "Rebase stopped with conflicts. Resolve them and run git rebase --continue."
      warn "Abort with git rebase --abort; the safety branch is $backup."
      exit 1
    fi
  else
    log "main is already based on $target_tag"
  fi

  refresh_disabled_workflows "$target_tag"
  check_workflows

  local rebased_version
  rebased_version=$(package_version)
  [[ "$rebased_version" == "$target_version" ]] ||
    die "Rebase completed but package.json reports $rebased_version instead of $target_version"
  verify_custom_commit_stack "$target_tag"
  log "Rebase onto $target_tag completed"
}

cmd_verify() {
  [[ $# -le 1 ]] || die "Usage: ./shasderias.sh verify [version]"
  ensure_main_branch
  ensure_clean_worktree
  ensure_pinned_node

  local version base
  version=$(package_version)
  if [[ $# -eq 1 ]]; then
    local requested
    requested=$(normalize_version "$1")
    [[ "$version" == "$requested" ]] ||
      die "main reports version $version, expected $requested"
  fi
  base="v$version"

  git rev-parse --verify "$base^{commit}" >/dev/null 2>&1 || die "Missing upstream base tag $base"
  git merge-base --is-ancestor "$base" HEAD || die "$base is not an ancestor of main"
  verify_workspace_versions "$version"
  check_workflows
  verify_custom_commit_stack "$base"

  log "Installing exact locked dependencies"
  npm ci
  log "Building server stack required by workspace typechecks"
  npm run build:server
  npm run build --workspace=@getpaseo/expo-two-way-audio
  log "Running repository checks"
  npm run format:check
  npm run lint
  npm run typecheck
  log "Running focused fork tests"
  npx vitest run \
    packages/desktop/src/customization.test.ts \
    packages/desktop/src/features/auto-updater.test.ts \
    packages/app/src/desktop/updates/desktop-updates.test.ts \
    --bail=1

  ensure_clean_worktree
  log "Verification passed for v$version"
}

wait_for_workflow_run() {
  local workflow=$1
  local sha=$2
  local attempts=${3:-120}
  local row="" run_id="" status="" conclusion=""

  require_command gh
  require_command timeout
  for (( attempt = 1; attempt <= attempts; attempt += 1 )); do
    row=$(gh run list \
      --repo "$FORK_REPO" \
      --workflow "$workflow" \
      --commit "$sha" \
      --limit 20 \
      --json databaseId,status,conclusion \
      --jq 'sort_by(.databaseId) | last | [.databaseId, .status, (.conclusion // "")] | @tsv' || true)
    if [[ -n "$row" ]]; then
      IFS=$'\t' read -r run_id status conclusion <<<"$row"
      if [[ "$status" == "completed" && "$conclusion" == "success" ]]; then
        log "$workflow run $run_id already succeeded"
        return
      fi
      if [[ "$status" == "completed" ]]; then
        log "Rerunning unsuccessful $workflow run $run_id ($conclusion)"
        if [[ "$conclusion" == "failure" ]]; then
          gh run rerun "$run_id" --repo "$FORK_REPO" --failed
        else
          gh run rerun "$run_id" --repo "$FORK_REPO"
        fi
      fi
      log "Watching $workflow run $run_id"
      timeout 60m gh run watch "$run_id" --repo "$FORK_REPO" --exit-status
      return
    fi
    sleep 5
  done

  die "Timed out waiting for workflow '$workflow' on commit $sha"
}

latest_workflow_run_id() {
  local workflow=$1
  local event=${2:-}
  local args=(
    run list
    --repo "$FORK_REPO"
    --workflow "$workflow"
    --limit 20
    --json databaseId
    --jq 'sort_by(.databaseId) | last | .databaseId // empty'
  )
  if [[ -n "$event" ]]; then
    args+=(--event "$event")
  fi
  gh "${args[@]}" 2>/dev/null || true
}

wait_for_new_workflow_run() {
  local workflow=$1
  local event=$2
  local baseline=${3:-}
  local run_id=""

  require_command gh
  for (( attempt = 1; attempt <= 60; attempt += 1 )); do
    run_id=$(latest_workflow_run_id "$workflow" "$event")
    if [[ -n "$run_id" && "$run_id" != "$baseline" ]]; then
      log "Watching new $workflow run $run_id"
      timeout 60m gh run watch "$run_id" --repo "$FORK_REPO" --exit-status
      return
    fi
    sleep 5
  done

  die "Timed out waiting for a new '$workflow' $event run"
}

push_main_with_lease() {
  local expected=$1
  log "Pushing rebased main with force-with-lease against $expected"
  git push \
    --force-with-lease="main:$expected" \
    --force-if-includes \
    origin main
}

remote_tag_commit() {
  local tag=$1
  local commit
  commit=$(git ls-remote origin "refs/tags/$tag^{}" | awk 'NR == 1 { print $1 }')
  if [[ -z "$commit" ]]; then
    commit=$(git ls-remote origin "refs/tags/$tag" | awk 'NR == 1 { print $1 }')
  fi
  printf '%s\n' "$commit"
}

create_and_push_release_tag() {
  local tag=$1
  local head local_commit remote_commit
  head=$(git rev-parse HEAD)

  if git rev-parse --verify "$tag^{commit}" >/dev/null 2>&1; then
    local_commit=$(git rev-list -n 1 "$tag")
    [[ "$local_commit" == "$head" ]] ||
      die "Local tag $tag points to $local_commit instead of HEAD $head"
  else
    log "Creating annotated tag $tag"
    git tag -a "$tag" -m "Paseo $tag"
  fi

  remote_commit=$(remote_tag_commit "$tag")
  if [[ -n "$remote_commit" ]]; then
    [[ "$remote_commit" == "$head" ]] ||
      die "Remote tag $tag points to $remote_commit instead of HEAD $head"
    log "Remote tag $tag already points to HEAD"
  else
    log "Pushing tag $tag"
    git push origin "$tag"
  fi
}

verify_release_assets() {
  local tag=$1
  local version=$2
  local sha=$3
  local -a actual expected

  require_command gh
  mapfile -t actual < <(
    gh release view "$tag" --repo "$FORK_REPO" --json assets --jq '.assets[].name' | sort
  )
  mapfile -t expected < <(
    printf '%s\n' \
      "Paseo-${version}-shasderias-${sha}-linux-x64.tar.gz" \
      "Paseo-${version}-shasderias-${sha}-windows-arm64.zip" \
      "Paseo-${version}-shasderias-${sha}-windows-x64.zip" \
      "SHA256SUMS" |
      sort
  )

  if ! diff -u <(printf '%s\n' "${expected[@]}") <(printf '%s\n' "${actual[@]}"); then
    die "Release $tag does not contain exactly the expected assets"
  fi
  log "Release $tag contains exactly the expected archive assets"
}

dispatch_archive_workflow() {
  local tag=$1
  require_command gh
  log "Dispatching $RELEASE_WORKFLOW_FILE for $tag"
  gh workflow run "$RELEASE_WORKFLOW_FILE" \
    --repo "$FORK_REPO" \
    --ref main \
    -f tag="$tag"
}

release_preflight() {
  local tag=$1
  require_command gh
  require_command timeout
  gh repo view "$FORK_REPO" --json nameWithOwner --jq .nameWithOwner >/dev/null ||
    die "gh cannot access $FORK_REPO; verify authentication for the origin host"

  if [[ -n $(remote_tag_commit "$tag") ]]; then
    die "Release tag $tag already exists; use rebuild, or release with --revision 2 or higher"
  fi
  if git rev-parse --verify "$tag^{commit}" >/dev/null 2>&1; then
    die "Local tag $tag already exists without a matching remote release; inspect it before continuing"
  fi
}

cmd_release() {
  parse_version_revision "$@"
  local version=$PARSED_VERSION
  local revision=$PARSED_REVISION
  local tag sha short_sha expected_origin_main
  tag=$(release_tag_for "$version" "$revision")

  ensure_main_branch
  ensure_clean_worktree
  fetch_remotes
  expected_origin_main=$(git rev-parse refs/remotes/origin/main)
  release_preflight "$tag"

  cmd_rebase "$version"
  cmd_verify "$version"

  push_main_with_lease "$expected_origin_main"
  sha=$(git rev-parse HEAD)
  wait_for_workflow_run "ci.yml" "$sha"

  create_and_push_release_tag "$tag"
  wait_for_workflow_run "$RELEASE_WORKFLOW_FILE" "$sha"

  short_sha=${sha:0:12}
  verify_release_assets "$tag" "$version" "$short_sha"
  log "Release complete: $tag"
}

cmd_rebuild() {
  parse_version_revision "$@"
  local version=$PARSED_VERSION
  local revision=$PARSED_REVISION
  local tag sha short_sha
  tag=$(release_tag_for "$version" "$revision")

  fetch_remotes
  sha=$(remote_tag_commit "$tag")
  [[ -n "$sha" ]] || die "Remote tag does not exist: $tag"
  local baseline
  baseline=$(latest_workflow_run_id "$RELEASE_WORKFLOW_FILE" "workflow_dispatch")
  dispatch_archive_workflow "$tag"
  wait_for_new_workflow_run "$RELEASE_WORKFLOW_FILE" "workflow_dispatch" "$baseline"
  short_sha=${sha:0:12}
  verify_release_assets "$tag" "$version" "$short_sha"
  log "Rebuild complete: $tag"
}

main() {
  require_command git
  initialize_fork_repo
  case "${1:-help}" in
    status)
      shift
      [[ $# -eq 0 ]] || die "status takes no arguments"
      cmd_status
      ;;
    check-workflows)
      shift
      [[ $# -eq 0 ]] || die "check-workflows takes no arguments"
      check_workflows
      ;;
    rebase|update)
      shift
      cmd_rebase "$@"
      ;;
    verify)
      shift
      cmd_verify "$@"
      ;;
    release)
      shift
      cmd_release "$@"
      ;;
    rebuild)
      shift
      cmd_rebuild "$@"
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      usage >&2
      die "Unknown command: $1"
      ;;
  esac
}

main "$@"
