# Selene public site deployment

The **Deploy Selene public site** workflow publishes GitHub Pages only after eligible changes reach
`main`, or when a maintainer dispatches it manually. Pull requests never receive deployment
credentials and do not publish previews.

The deployed site contains:

- a lightweight Selene landing page;
- the built web demo at `/demo/`;
- the built shared-component Storybook at `/storybook/`; and
- the versioned architecture source documents under `/docs/`.

Enable GitHub Pages with **GitHub Actions** as its source before the first deployment. The workflow
uses GitHub's Pages environment and only the `pages: write` and `id-token: write` permissions
needed for deployment; the build job retains only `contents: read` in addition to those GitHub
Pages capabilities. It does not use custom deployment secrets. To roll back a site change, revert
the reviewed commit on `main`; the pinned Pages workflow deploys that commit as the next revision.
