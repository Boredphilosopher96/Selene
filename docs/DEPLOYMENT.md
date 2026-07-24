# Selene public site deployment

The **Deploy Selene public site** workflow publishes GitHub Pages only after eligible changes reach
`main`, or when a maintainer dispatches it manually. Pull requests never receive deployment
credentials and do not publish previews.

The deployed site contains:

- a lightweight Selene landing page;
- the built web demo at `/demo/`;
- the built shared-component Storybook at `/storybook/`; and
- the versioned architecture source documents under `/docs/`.

Before a change can reach the deployment workflow, continuous integration builds the
browser demo, Storybook, and Electron renderer and checks their emitted-size budgets.
Accessibility is also checked independently with axe-core against the browser prototype,
the Storybook iframe, and the built desktop renderer. The desktop check serves the emitted
renderer instead of requiring a native display server. These checks use uncompressed emitted
file sizes so the public demo and its component documentation remain bounded even when their
source-level dependency graphs change.

Enable GitHub Pages with **GitHub Actions** as its source before the first deployment. The workflow
uses GitHub's Pages environment and only the `pages: write` and `id-token: write` permissions
needed for deployment; the build job retains only `contents: read` in addition to those GitHub
Pages capabilities. It does not use custom deployment secrets. To roll back a site change, revert
the reviewed commit on `main`; the pinned Pages workflow deploys that commit as the next revision.
