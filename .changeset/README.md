# Changesets

Every PR that changes behaviour adds one of these: run `pnpm changeset`, pick
the bump (patch/minor/major), and write a sentence for the person upgrading —
not the person reviewing. The release PR that accumulates them is opened and
kept fresh by CI; merging it versions, writes the changelog, publishes to npm
through trusted publishing, and tags.

Docs: https://github.com/changesets/changesets
