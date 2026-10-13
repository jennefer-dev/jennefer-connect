# Releasing

Releases are published by hand from this folder. There is no CI.

1. Bump the version (updates `package.json`, commits and tags):

   ```bash
   npm version patch   # or minor / major
   ```

2. Publish. This runs the build and the tests first (`prepublishOnly`), then asks for your npm 2FA:

   ```bash
   npm publish --access public
   ```

3. npm uses staged publishing for this package: release the new version on npmjs.com
   (package page, staged versions) and confirm with 2FA.

4. Push the commit and the tag:

   ```bash
   git push --follow-tags
   ```

5. Check it: `npm view @jennefer-dev/connect version` shows the new version.
