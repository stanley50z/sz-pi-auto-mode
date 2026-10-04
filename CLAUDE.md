## Automode MVP

For work on Automode launch, orchestration, or any Automation Stage, use [the implementation specification](https://github.com/stanley50z/sz-pi-auto-mode/issues/21). The [Wayfinder map](https://github.com/stanley50z/sz-pi-auto-mode/issues/1) indexes the underlying decisions. The entrypoint is `/automode` inside normal Pi; `pi automode` is obsolete. Personal-WeChat integration is outside this MVP.

<!-- OPENWIKI:START -->

## OpenWiki

For code documentation, start with `openwiki/quickstart.md`. Treat source code and tests as authoritative. The ignored `openwiki/` directory is this repository's separate native GitHub Wiki clone; `Home.md` is its published landing page.

Refresh locally from the project root with `openwiki code --update --print`, setting `OPENWIKI_PROVIDER=openai-chatgpt` and `OPENWIKI_MODEL_ID=gpt-5.6-luna` using the saved ChatGPT subscription login. Review and publish page changes in the Wiki repository. Keep generation local-only.

Migration diagnostics: `C:/Users/13982/.tmp/openwiki-root-update/sz-pi-auto-mode/` contains `generation.log`, validation results, snapshots, and `*-crash-report.txt` stack traces when a helper fails.

<!-- OPENWIKI:END -->
