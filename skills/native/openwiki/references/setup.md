# First-time setup

Three independent first-times: each machine, each repository, and each repository's wiki needs its own.

## Machine: install the CLI

```powershell
npm install --global openwiki
```

The ChatGPT-subscription login is captured during the machine's first `--init` and saved to `~/.openwiki/.env`; later runs in any repository reuse it, and the access token refreshes itself on expiry.

## Repository: generate the docs

From the repository root:

```powershell
$env:OPENWIKI_PROVIDER = 'openai-chatgpt'
openwiki code --init
```

Complete the browser login at `auth.openai.com` — the wizard also prints the URL for headless use, where you open it on another machine and paste the redirect URL back into the terminal — then select the model. The run generates `openwiki/` and writes the `<!-- OPENWIKI:START/END -->` blocks into `AGENTS.md` and `CLAUDE.md`, creating those files if absent.

Review `git status --short`, `git diff --check`, and `git diff` before committing.

Done when `openwiki/quickstart.md` exists, both agent files carry an OPENWIKI block, and no OpenWiki CI workflow was added.

## Wiki: create and clone

The `<repo>.wiki.git` remote only comes into existence once the wiki has a saved first page. If the remote is unavailable, invoke the `browser-harness` skill and complete the prerequisite through GitHub's web interface:

1. Open the repository **Settings** page and enable **Wikis** under **Features**.
2. Open the repository **Wiki** tab, create `Home` with the temporary body `Initializing OpenWiki publication.`, and save it.
3. Verify that the Wiki remote resolves, then ignore and clone it inside the main repository:

   ```powershell
   Add-Content .gitignore "/wiki/"
   git clone https://github.com/<owner>/<repo>.wiki.git wiki
   ```

   If `/wiki/` is already ignored, leave `.gitignore` unchanged. If `wiki/` already exists, verify that it is the correct Wiki clone; stop and report a path collision instead of replacing any existing content.

Use the browser's existing GitHub session. Stop only for user-only authentication or confirmation, missing repository administration permission, or a plan that does not expose Wikis; report that concrete blocker. Once the clone succeeds, continue the publication flow in the same run.

GitHub's documentation:

- <https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages>
- <https://docs.github.com/en/communities/documenting-your-project-with-wikis/creating-a-footer-or-sidebar-for-your-wiki>
