// == Site Archive (*.star) file layout (subject to rapid change) ==
//
// /star.json
//
//  - format: "site-archive-pre1" for this version
//
//  - builtBy: human readable banner (eg, "Meteor 0.6.0")
//
//  - programs: array of programs in the star, each an object:
//    - name: short, unique name for program, for referring to it
//      programmatically
//    - arch: architecture that this program targets. Something like
//            "os", "os.linux.x86_64", or "browser.w3c".
//    - path: directory (relative to star.json) containing this program
//
//    XXX in the future this will also contain instructions for
//    mounting packages into the namespace of each program, and
//    possibly for mounting programs on top of each other (this would
//    be the principled mechanism by which a server program could read
//    a client program so it can server it)
//
//  - plugins: array of plugins in the star, each an object:
//    - name: short, unique name for plugin, for referring to it
//      programmatically
//    - arch: typically 'os' (for a portable plugin) or eg
//      'os.linux.x86_64' for one that include native node_modules
//    - path: path (relative to star.json) to the control file (eg,
//      program.json) for this plugin
//
// - meteorRelease: the value used in Meteor.release for programs inside the
//     star, or "none"
//
// /README: human readable instructions
//
// /main.js: script that can be run in node.js to start the site
//   running in standalone mode (after setting appropriate environment
//   variables as documented in README)
//
// /server/.bundle_version.txt: contains the dev_bundle version that the meteor
//   deploy server reads in order to set NODE_PATH to point to arch-specific
//   builds of binary node modules
//
// XXX in the future one program (which must be a server-type
// architecture) will be designated as the 'init' program. The
// container will call it with arguments to signal app lifecycle
// events like 'start' and 'stop'.
//
//
// Conventionally programs will be located at /programs/<name>, but
// really the build tool can lay out the star however it wants.
//
//
// == Format of a program when arch is "web.*" ==
//
// Standard:
//
// /program.json
//
//  - format: "web-program-pre1" for this version
//
//  - manifest: array of resources to serve with HTTP, each an object:
//    - path: path of file relative to program.json
//    - where: "client"
//    - type: "js", "css", or "asset"
//    - cacheable: is it safe to ask the client to cache this file (boolean)
//    - url: relative url to download the resource, includes cache busting
//        parameter when used
//    - size: size of file in bytes
//    - hash: sha1 hash of the file contents
//    - sourceMap: optional path to source map file (relative to program.json)
//
//    Additionally there may be a manifest entry with where equal to
//    "internal", type "head" or "body", and a path and hash. These contain
//    chunks of HTML which should be inserted in the boilerplate HTML page's
//    <head> or <body> respectively.
//
//
// == Format of a program when arch is "os.*" ==
//
// Standard:
//
// /server.js: script to run inside node.js to start the program
//
// XXX Subject to change! This will likely change to a shell script
// (allowing us to represent types of programs that don't use or
// depend on node) -- or in fact, rather than have anything fixed here
// at all, star.json just contains a path to a program to run, which
// can be anything than can be exec()'d.
//
// Convention:
//
// /program.json:
//
//  - load: array with each item describing a JS file to load at startup:
//    - path: path of file, relative to program.json
//    - node_modules: if Npm.require is called from this file, this is
//      the path (relative to program.json) of the directory that should
//      be search for npm modules
//    - assets: map from path (the argument to Assets.getText and
//      Assets.getBinary) to path on disk (relative to program.json)
//      of the asset
//    - sourceMap: if present, path of a file that contains a source
//      map for this file, relative to program.json
//
// /config.json:
//
//  - client: the client program that should be served up by HTTP,
//    expressed as a path (relative to program.json) to the *client's*
//    program.json.
//
//  - meteorRelease: the value to use for Meteor.release, if any
//
//
// /app/*: source code of the (server part of the) app
// /packages/foo.js: the (linked) source code for package foo
// /package-tests/foo.js: the (linked) source code for foo's tests
// /npm/foo/node_modules: node_modules for package foo. may be symlinked
//     if developing locally.
//
// /node_modules: node_modules needed for server.js. omitted if
// deploying (see .bundle_version.txt above), copied if bundling,
// symlinked if developing locally.
//
//
// == Format of a program that is to be used as a plugin ==
//
// /program.json:
//  - format: "javascript-image-pre1" for this version
//  - arch: the architecture that this build requires
//  - load: array with each item describing a JS file to load, in load order:
//    - path: path of file, relative to program.json
//    - node_modules: if Npm.require is called from this file, this is
//      the path (relative to program.json) of the directory that should
//      be search for npm modules
//
// It's a little odd that architecture is stored twice (in both the
// top-level star control file and in the plugin control file) but
// it's fine and it's probably actually cleaner, because it means that
// the plugin can be treated as a self-contained unit.
//
// Note that while the spec for "os.*" is going to change to
// represent an arbitrary POSIX (or Windows) process rather than
// assuming a nodejs host, these plugins will always refer to
// JavaScript code (that potentially might be a plugin to be loaded
// into an existing JS VM). But this seems to be a concern that is
// somewhat orthogonal to arch (these plugins can still use packages
// of arch "os.*"). There is probably a missing abstraction here
// somewhere (decoupling target type from architecture) but it can
// wait until later.

var util = require('util');
var files = require('./files.js');
var Builder = require('./builder.js');
var archinfo = require('./archinfo.js');
var buildmessage = require('./buildmessage.js');
var _ = require('underscore');
var isopackets = require("./isopackets.js");
var watch = require('./watch.js');
var release = require('./release.js');
var Fiber = require('fibers');
var Future = require('fibers/future');
var sourcemap = require('source-map');
var runLog = require('./run-log.js');
var PackageSource = require('./package-source.js');
var Profile = require('./profile.js').Profile;
var compiler = require('./compiler.js');
var packageVersionParser = require('./package-version-parser.js');
var colonConverter = require('./colon-converter.js');

// files to ignore when bundling. node has no globs, so use regexps
exports.ignoreFiles = [
    /~$/, /^\.#/, /^#.*#$/,  // emacs swap files
    /^\..*\.sw.$/,  // vim swap files
    /^\.DS_Store\/?$/, /^ehthumbs\.db$/, /^Icon.$/, /^Thumbs\.db$/,
    /^\.meteor\/$/, /* avoids scanning N^2 files when bundling all packages */
    /^\.git\/$/ /* often has too many files to watch */
];

var rejectBadPath = function (p) {
  if (p.match(/\.\./))
    throw new Error("bad path: " + p);
};

var stripLeadingSlash = function (p) {
  if (p.charAt(0) === '/') {
    return p.slice(1);
  }

  return p;
};


// Contents of main.js in bundles. Exported for use by the bundler
// tests.
exports._mainJsContents = [
  "",
  "// The debugger pauses here when you run `meteor debug`, because this is ",
  "// the very first code to be executed by the server process. If you have ",
  "// not already added any `debugger` statements to your code, feel free to ",
  "// do so now, wait for the server to restart, then reload this page and ",
  "// click the |\u25b6 button to continue.",
  "process.argv.splice(2, 0, 'program.json');",
  "process.chdir(require('path').join(__dirname, 'programs', 'server'));",
  "require('./programs/server/boot.js');",
].join("\n");

///////////////////////////////////////////////////////////////////////////////
// NodeModulesDirectory
///////////////////////////////////////////////////////////////////////////////

// Represents a node_modules directory that we need to copy into the
// bundle or otherwise make available at runtime.
var NodeModulesDirectory = function (options) {
  var self = this;

  // The absolute path (on local disk) to a directory that contains
  // the built node_modules to use.
  self.sourcePath = options.sourcePath;

  // The path (relative to the bundle root) where we would preferably
  // like the node_modules to be output (essentially cosmetic).
  self.preferredBundlePath = options.preferredBundlePath;

  // Optionally, files to discard.
  self.npmDiscards = options.npmDiscards;

  // Write a package.json file instead of copying the full directory.
  self.writePackageJSON = !!options.writePackageJSON;
};

///////////////////////////////////////////////////////////////////////////////
// File
///////////////////////////////////////////////////////////////////////////////

// Allowed options:
// - sourcePath: path to file on disk that will provide our contents
// - data: contents of the file as a Buffer
// - hash: optional, sha1 hash of the file contents, if known
// - sourceMap: if 'data' is given, can be given instead of sourcePath. a string
// - cacheable
var File = function (options) {
  var self = this;

  if (options.data && ! (options.data instanceof Buffer))
    throw new Error('File contents must be provided as a Buffer');
  if (! options.sourcePath && ! options.data)
    throw new Error("Must provide either sourcePath or data");

  // The absolute path in the filesystem from which we loaded (or will
  // load) this file (null if the file does not correspond to one on
  // disk).
  self.sourcePath = options.sourcePath;

  self.info = options.info || '?';

  // If this file was generated, a sourceMap (as a string) with debugging
  // information, as well as the "root" that paths in it should be resolved
  // against. Set with setSourceMap.
  self.sourceMap = null;
  self.sourceMapRoot = null;

  // Where this file is intended to reside within the target's
  // filesystem.
  self.targetPath = null;

  // The URL at which this file is intended to be served, relative to
  // the base URL at which the target is being served (ignored if this
  // file is not intended to be served over HTTP).
  self.url = null;

  // Is this file guaranteed to never change, so that we can let it be
  // cached forever? Only makes sense of self.url is set.
  self.cacheable = options.cacheable || false;

  // The node_modules directory that Npm.require() should search when
  // called from inside this file, given as a NodeModulesDirectory, or
  // null if Npm.depend() is not in effect for this file. Only works
  // in the "server" architecture.
  self.nodeModulesDirectory = null;

  // For server JS only. Assets associated with this slice; map from the path
  // that is the argument to Assets.getBinary, to a Buffer that is its contents.
  self.assets = null;

  self._contents = options.data || null; // contents, if known, as a Buffer
  self._hash = options.hash || null; // hash, if known, as a hex string
};

_.extend(File.prototype, {
  toString: function() {
    var self = this;
    return "File: [info=" + self.info + "]";
  },

  hash: function () {
    var self = this;
    if (! self._hash)
      self._hash = watch.sha1(self.contents());
    return self._hash;
  },

  // Omit encoding to get a buffer, or provide something like 'utf8'
  // to get a string
  contents: function (encoding) {
    var self = this;
    if (! self._contents) {
      if (! self.sourcePath) {
        throw new Error("Have neither contents nor sourcePath for file");
      }
      else
        self._contents = files.readFile(self.sourcePath);
    }

    return encoding ? self._contents.toString(encoding) : self._contents;
  },

  setContents: function (b) {
    var self = this;
    if (!(b instanceof Buffer))
      throw new Error("Must set contents to a Buffer");
    self._contents = b;
    // Un-cache hash.
    self._hash = null;
  },

  size: function () {
    var self = this;
    return self.contents().length;
  },

  // Set the URL (and target path) of this file to "/<hash><suffix>". suffix
  // will typically be used to pick a reasonable extension. Also set cacheable
  // to true, since the file's name is now derived from its contents.

  // Also allow a special second suffix that will *only* be postpended to the
  // url, useful for query parameters.
  setUrlToHash: function (fileAndUrlSuffix, urlSuffix) {
    var self = this;
    urlSuffix = urlSuffix || "";
    self.url = "/" + self.hash() + fileAndUrlSuffix + urlSuffix;
    self.cacheable = true;
    self.targetPath = self.hash() + fileAndUrlSuffix;
  },

  // Append "?<hash>" to the URL and mark the file as cacheable.
  addCacheBuster: function () {
    var self = this;
    if (! self.url)
      throw new Error("File must have a URL");
    if (self.cacheable)
      return; // eg, already got setUrlToHash
    if (/\?/.test(self.url))
      throw new Error("URL already has a query string");
    self.url += "?" + self.hash();
    self.cacheable = true;
  },

  // Given a relative path like 'a/b/c' (where '/' is this system's
  // path component separator), produce a URL that always starts with
  // a forward slash and that uses a literal forward slash as the
  // component separator.
  setUrlFromRelPath: function (relPath) {
    var self = this;
    var url = relPath;

    if (url.charAt(0) !== '/')
      url = '/' + url;

    // XXX replacing colons with underscores as colon is hard to escape later
    // on different targets and generally is not a good separator for web.
    url = url.replace(/:/g, '_');
    self.url = url;
  },

  setTargetPathFromRelPath: function (relPath) {
    var self = this;
    // XXX hack
    if (relPath.match(/^packages\//) || relPath.match(/^assets\//))
      self.targetPath = relPath;
    else
      self.targetPath = files.pathJoin('app', relPath);

    // XXX same as in setUrlFromRelPath, we replace colons with a different
    // separator to avoid difficulties further. E.g.: on Windows it is not a
    // valid char in filename, Cordova also rejects it, etc.
    self.targetPath = self.targetPath.replace(/:/g, '_');
  },

  // Set a source map for this File. sourceMap is given as a string.
  setSourceMap: function (sourceMap, root) {
    var self = this;

    if (typeof sourceMap !== "string")
      throw new Error("sourceMap must be given as a string");
    self.sourceMap = sourceMap;
    self.sourceMapRoot = root;
  },

  // note: this assets object may be shared among multiple files!
  setAssets: function (assets) {
    var self = this;
    if (!_.isEmpty(assets))
      self.assets = assets;
  }
});

///////////////////////////////////////////////////////////////////////////////
// Target
///////////////////////////////////////////////////////////////////////////////

// options:
// - packageMap and isopackCache: for resolving package dependencies
// - arch: the architecture to build
// - cordovaPluginsFile: projectContextModule.CordovaPluginsFile object
// - includeDebug: whether to include packages marked debugOnly in this target
//
// see subclasses for additional options
var Target = function (options) {
  var self = this;

  self.packageMap = options.packageMap;
  self.isopackCache = options.isopackCache;

  // Something like "web.browser" or "os" or "os.osx.x86_64"
  self.arch = options.arch;

  // All of the Unibuilds that are to go into this target, in the order
  // that they are to be loaded.
  self.unibuilds = [];

  // JavaScript files. List of File. They will be loaded at startup in
  // the order given.
  self.js = [];

  // On-disk dependencies of this target.
  self.watchSet = new watch.WatchSet();

  // List of all package names used in this target.
  self.usedPackages = {};

  // node_modules directories that we need to copy into the target (or
  // otherwise make available at runtime). A map from an absolute path
  // on disk (NodeModulesDirectory.sourcePath) to a
  // NodeModulesDirectory object that we have created to represent it.
  //
  // The NodeModulesDirectory objects in this map are de-duplicated
  // aliases to the objects in the nodeModulesDirectory fields of
  // the File objects in self.js.
  self.nodeModulesDirectories = {};

  // Static assets to include in the bundle. List of File.
  // For client targets, these are served over HTTP.
  self.asset = [];

  // The project's cordova plugins file (which lists plugins used directly by
  // the project).
  self.cordovaPluginsFile = options.cordovaPluginsFile;

  // A mapping from Cordova plugin name to Cordova plugin version number.
  self.cordovaDependencies = self.cordovaPluginsFile ? {} : null;

  self.providePackageJSONForUnavailableBinaryDeps =
    !!options.providePackageJSONForUnavailableBinaryDeps;

  // For the todos sample app:
  // false: 99.6 KB / 316 KB
  // vs
  // true: 99 KB / 315 KB

  // METEOR_MINIFY_LEGACY is an undocumented safety-valve environment variable,
  //  in case people hit trouble
  self._minifyTogether = !!process.env.METEOR_MINIFY_LEGACY;

  self.includeDebug = options.includeDebug;
};

_.extend(Target.prototype, {
  // Top-level entry point for building a target. Generally to build a
  // target, you create with 'new', call make() to specify its sources
  // and build options and actually do the work of buliding the
  // target, and finally you retrieve the build product with a
  // target-type-dependent function such as write() or toJsImage().
  //
  // options
  // - packages: packages to include (Isopack or 'foo'), per
  //   _determineLoadOrder
  // - minify: true to minify
  // - addCacheBusters: if true, make all files cacheable by adding
  //   unique query strings to their URLs. unlikely to be of much use
  //   on server targets.
  make: Profile("Target#make", function (options) {
    var self = this;
    buildmessage.assertInCapture();

    // Populate the list of unibuilds to load
    self._determineLoadOrder({
      packages: options.packages || []
    });

    // Link JavaScript and set up self.js, etc.
    self._emitResources();

    // Add top-level Cordova dependencies, which override Cordova
    // dependencies from packages.
    self._addDirectCordovaDependencies();

    // Preprocess and concatenate CSS files for client targets.
    if (self instanceof ClientTarget) {
      self.mergeCss();
    }

    // Minify, if requested
    if (options.minify) {
      var minifiers = isopackets.load('minifiers').minifiers;
      self.minifyJs(minifiers);

      // CSS is minified only for client targets.
      if (self instanceof ClientTarget) {
        self.minifyCss(minifiers);
      }
    }

    if (options.addCacheBusters) {
      // Make client-side CSS and JS assets cacheable forever, by
      // adding a query string with a cache-busting hash.
      self._addCacheBusters("js");
      self._addCacheBusters("css");
    }
  }),

  // Determine the packages to load, create Unibuilds for
  // them, put them in load order, save in unibuilds.
  //
  // options include:
  // - packages: an array of packages (or, properly speaking, unibuilds)
  //   to include. Each element should either be a Isopack object or a
  //   package name as a string
  _determineLoadOrder: function (options) {
    var self = this;
    buildmessage.assertInCapture();

    var packageMap = self.packageMap;
    var isopackCache = self.isopackCache;

    buildmessage.enterJob("linking the program", function () {
      // Find the roots
      var rootUnibuilds = [];
      _.each(options.packages, function (p) {
        if (typeof p === "string") {
          p = isopackCache.getIsopack(p);
        }
        if (p.debugOnly && ! self.includeDebug) {
          return;
        }
        var unibuild = p.getUnibuildAtArch(self.arch, {
          allowWrongPlatform: self.providePackageJSONForUnavailableBinaryDeps
        });
        unibuild && rootUnibuilds.push(unibuild);
      });

      if (buildmessage.jobHasMessages())
        return;

      // PHASE 1: Which unibuilds will be used?
      //
      // Figure out which unibuilds are going to be used in the target,
      // regardless of order. We ignore weak dependencies here, because they
      // don't actually create a "must-use" constraint, just an ordering
      // constraint.

      // What unibuilds will be used in the target? Built in Phase 1, read in
      // Phase 2.
      var usedUnibuilds = {};  // Map from unibuild.id to Unibuild.
      self.usedPackages = {};  // Map from package name to true;
      var addToGetsUsed = function (unibuild) {
        if (_.has(usedUnibuilds, unibuild.id))
          return;
        usedUnibuilds[unibuild.id] = unibuild;
        if (unibuild.kind === 'main') {
          // Only track real packages, not plugin pseudo-packages.
          self.usedPackages[unibuild.pkg.name] = true;
        }
        compiler.eachUsedUnibuild({
          dependencies: unibuild.uses,
          arch: self.arch,
          isopackCache: isopackCache,
          skipDebugOnly: ! self.includeDebug,
          allowWrongPlatform: self.providePackageJSONForUnavailableBinaryDeps
        }, addToGetsUsed);
      };
      _.each(rootUnibuilds, addToGetsUsed);

      if (buildmessage.jobHasMessages())
        return;

      // PHASE 2: In what order should we load the unibuilds?
      //
      // Set self.unibuilds to be all of the roots, plus all of their non-weak
      // dependencies, in the correct load order. "Load order" means that if X
      // depends on (uses) Y, and that relationship is not marked as unordered,
      // Y appears before X in the ordering. Raises an exception iff there is no
      // such ordering (due to circular dependency).
      //
      // The topological sort code here is similar to code in isopack-cache.js,
      // though they do serve slightly different purposes: that one determines
      // build order dependencies and this one determines load order
      // dependencies.

      // What unibuilds have not yet been added to self.unibuilds?
      var needed = _.clone(usedUnibuilds);  // Map from unibuild.id to Unibuild.
      // Unibuilds that we are in the process of adding; used to detect circular
      // ordered dependencies.
      var onStack = {};  // Map from unibuild.id to true.

      // This helper recursively adds unibuild's ordered dependencies to
      // self.unibuilds, then adds unibuild itself.
      var add = function (unibuild) {
        // If this has already been added, there's nothing to do.
        if (!_.has(needed, unibuild.id))
          return;

        // Process each ordered dependency. (If we have an unordered dependency
        // `u`, then there's no reason to add it *now*, and for all we know, `u`
        // will depend on `unibuild` and need to be added after it. So we ignore
        // those edge. Because we did follow those edges in Phase 1, any
        // unordered unibuilds were at some point in `needed` and will not be
        // left out).
        //
        // eachUsedUnibuild does follow weak edges (ie, they affect the
        // ordering), but only if they point to a package in usedPackages (ie, a
        // package that SOMETHING uses strongly).
        var processUnibuild = function (usedUnibuild) {
          if (onStack[usedUnibuild.id]) {
            buildmessage.error(
              "circular dependency between packages " +
                unibuild.pkg.name + " and " + usedUnibuild.pkg.name);
            // recover by not enforcing one of the depedencies
            return;
          }
          onStack[usedUnibuild.id] = true;
          add(usedUnibuild);
          delete onStack[usedUnibuild.id];
        };
        compiler.eachUsedUnibuild({
          dependencies: unibuild.uses,
          arch: self.arch,
          isopackCache: isopackCache,
          skipUnordered: true,
          acceptableWeakPackages: self.usedPackages,
          skipDebugOnly: ! self.includeDebug,
          allowWrongPlatform: self.providePackageJSONForUnavailableBinaryDeps
        }, processUnibuild);
        self.unibuilds.push(unibuild);
        delete needed[unibuild.id];
      };

      while (true) {
        // Get an arbitrary unibuild from those that remain, or break if none
        // remain.
        var first = null;
        for (first in needed) break;
        if (! first)
          break;
        // Now add it, after its ordered dependencies.
        add(needed[first]);
      }
    });
  },

  // Process all of the sorted unibuilds (which includes running the JavaScript
  // linker).
  _emitResources: function () {
    var self = this;

    var isWeb = archinfo.matches(self.arch, "web");
    var isOs = archinfo.matches(self.arch, "os");

    // Copy their resources into the bundle in order
    _.each(self.unibuilds, function (unibuild) {
      if (self.cordovaDependencies) {
        _.each(unibuild.pkg.cordovaDependencies, function (version, name) {
          self._addCordovaDependency(
            name,
            version,
            // use newer version if another version has already been added
            false
          );
        });
      }

      var isApp = ! unibuild.pkg.name;

      // Emit the resources
      var resources = unibuild.getResources(self.arch, {
        isopackCache: self.isopackCache
      });

      // First, find all the assets, so that we can associate them with each js
      // resource (for os unibuilds).
      var unibuildAssets = {};
      _.each(resources, function (resource) {
        if (resource.type !== "asset")
          return;

        var f = new File({
          info: 'unbuild ' + resource,
          data: resource.data,
          cacheable: false,
          hash: resource.hash
        });

        var relPath = isOs
              ? files.pathJoin("assets", resource.servePath)
              : stripLeadingSlash(resource.servePath);
        f.setTargetPathFromRelPath(relPath);

        if (isWeb)
          f.setUrlFromRelPath(resource.servePath);
        else {
          unibuildAssets[resource.path] = resource.data;
        }

        self.asset.push(f);
      });

      // Now look for the other kinds of resources.
      _.each(resources, function (resource) {
        if (resource.type === "asset")
          return;  // already handled

        if (_.contains(["js", "css"], resource.type)) {
          if (resource.type === "css" && ! isWeb)
            // XXX might be nice to throw an error here, but then we'd
            // have to make it so that package.js ignores css files
            // that appear in the server directories in an app tree

            // XXX XXX can't we easily do that in the css handler in
            // meteor.js?
            return;

          var f = new File({ info: 'resource ' + resource.servePath, data: resource.data, cacheable: false});

          var relPath = stripLeadingSlash(resource.servePath);
          f.setTargetPathFromRelPath(relPath);

          if (isWeb) {
            f.setUrlFromRelPath(resource.servePath);
          }

          if (resource.type === "js" && isOs) {
            // Hack, but otherwise we'll end up putting app assets on this file.
            if (resource.servePath !== "/packages/global-imports.js")
              f.setAssets(unibuildAssets);

            if (! isApp && unibuild.nodeModulesPath) {
              var nmd = self.nodeModulesDirectories[unibuild.nodeModulesPath];
              if (! nmd) {
                nmd = new NodeModulesDirectory({
                  sourcePath: unibuild.nodeModulesPath,
                  // It's important that this path end with
                  // node_modules. Otherwise, if two modules in this package
                  // depend on each other, they won't be able to find each
                  // other!
                  preferredBundlePath: files.pathJoin(
                    'npm',
                    colonConverter.convert(unibuild.pkg.name),
                    'node_modules'),
                  npmDiscards: unibuild.pkg.npmDiscards
                });
                self.nodeModulesDirectories[unibuild.nodeModulesPath] = nmd;
              }
              f.nodeModulesDirectory = nmd;

              if (!archinfo.matches(self.arch, unibuild.arch)) {
                // The unibuild we're trying to include doesn't work for the
                // bundle target (eg, os.osx.x86_64 instead of os.linux.x86_64)!
                // Hopefully this is because we specially enabled the feature
                // that leads to this.
                if (!self.providePackageJSONForUnavailableBinaryDeps) {
                  throw Error("mismatched arch without special feature enabled "
                              + unibuild.pkg.name + " / " + self.arch + " / " +
                              unibuild.arch);
                }
                if (!files.exists(
                  files.pathJoin(nmd.sourcePath, '.package.json'))) {
                  buildmessage.error(
                    "Can't cross-compile package " +
                      unibuild.pkg.name + ": missing .package.json");
                  return;
                }
                if (!files.exists(
                  files.pathJoin(nmd.sourcePath, '.npm-shrinkwrap.json'))) {
                  buildmessage.error(
                    "Can't cross-compile package " +
                      unibuild.pkg.name + ": missing .npm-shrinkwrap.json");
                  return;
                }
                nmd.writePackageJSON = true;
              }
            }
          }

          // Both CSS and JS files can have source maps
          if (resource.sourceMap) {
            f.setSourceMap(resource.sourceMap, files.pathDirname(relPath));
          }

          self[resource.type].push(f);
          return;
        }

        if (_.contains(["head", "body"], resource.type)) {
          if (! isWeb)
            throw new Error("HTML segments can only go to the client");
          self[resource.type].push(resource.data);
          return;
        }

        throw new Error("Unknown type " + resource.type);
      });

      // Depend on the source files that produced these resources.
      self.watchSet.merge(unibuild.watchSet);

      // Remember the versions of all of the build-time dependencies
      // that were used in these resources. Depend on them as well.
      // XXX assumes that this merges cleanly
       self.watchSet.merge(unibuild.pkg.pluginWatchSet);
    });
  },

  // Minify the JS in this target
  minifyJs: Profile("Target#minifyJs", function (minifiers) {
    var self = this;

    var allJs;

    var minifyOptions = {
      fromString: true,
      compress: {drop_debugger: false }
    };

    if (self._minifyTogether) {
      var sources = _.map(self.js, function (file) {
        return file.contents('utf8');
      });

      buildmessage.enterJob({title: "minifying"}, function () {
        allJs = _minify(minifiers.UglifyJS, '', sources, minifyOptions).code;
      });
    } else {
      minifyOptions.compress.unused = false;
      minifyOptions.compress.dead_code = false;

      allJs = buildmessage.forkJoin({title: "minifying" }, self.js, function (file) {
        var source = file.contents('utf8');
        return _minify(minifiers.UglifyJS, file.info, source, minifyOptions).code;
      }).join("\n\n");
    }

    self.js = [new File({ info: 'minified js', data: new Buffer(allJs, 'utf8') })];
    self.js[0].setUrlToHash(".js", '?meteor_js_resource=true');
  }),

  // Add a Cordova plugin dependency to the target. If the same plugin
  // has already been added at a different version and `override` is
  // false, use whichever version is newest. If `override` is true, then
  // we always add the exact version specified, overriding any other
  // version that has already been added.
  _addCordovaDependency: function (name, version, override) {
    var self = this;
    if (! self.cordovaDependencies)
      return;

    if (override) {
      self.cordovaDependencies[name] = version;
    } else {
      if (_.has(self.cordovaDependencies, name)) {
        var existingVersion = self.cordovaDependencies[name];
        self.cordovaDependencies[name] = packageVersionParser.
          lessThan(existingVersion, version) ? version : existingVersion;
      } else {
        self.cordovaDependencies[name] = version;
      }
    }
  },

  // Add Cordova plugins that have been directly added to the project
  // (i.e. are in .meteor/cordova-plugins).
  // XXX The versions of these direct dependencies override any versions
  // of the same plugins that packages are using.
  _addDirectCordovaDependencies: function () {
    var self = this;
    if (! self.cordovaDependencies)
      return;

    _.each(self.cordovaPluginsFile.getPluginVersions(), function (version, name) {
      self._addCordovaDependency(
        name, version, true /* override any existing version */);
    });
  },

  // For each resource of the given type, make it cacheable by adding
  // a query string to the URL based on its hash.
  _addCacheBusters: function (type) {
    var self = this;
    _.each(self[type], function (file) {
      file.addCacheBuster();
    });
  },

  // Return the WatchSet for this target's dependency info.
  getWatchSet: function () {
    var self = this;
    return self.watchSet;
  },

  // Return the most inclusive architecture with which this target is
  // compatible. For example, if we set out to build a
  // 'os.linux.x86_64' version of this target (by passing that as
  // the 'arch' argument to the constructor), but ended up not
  // including anything that was specific to Linux, the return value
  // would be 'os'.
  mostCompatibleArch: function () {
    var self = this;
    var arches = _.pluck(self.unibuilds, 'arch');
    if (self.providePackageJSONForUnavailableBinaryDeps) {
      // Filter out incompatible arches.
      arches = _.filter(arches, function (arch) {
        return archinfo.matches(self.arch, arch);
      });
    }
    return archinfo.leastSpecificDescription(arches);
  }
});

// This code is a copied-and-pasted version the minify function in UglifyJs2,
// with our progress class inserted.
var _minify = function (UglifyJS, key, files, options) {
  options = UglifyJS.defaults(options, {
    spidermonkey : false,
    outSourceMap : null,
    sourceRoot   : null,
    inSourceMap  : null,
    fromString   : false,
    warnings     : false,
    mangle       : {},
    output       : null,
    compress     : {}
  });
  UglifyJS.base54.reset();

  var totalFileSize = 0;
  _.forEach(files, function (file) {
    totalFileSize += file.length;
  });

  var phases = 2;
  if (options.compress) phases++;
  if (options.mangle) phases++;
  if (options.output) phases++;

  var progress = {current: 0, end: totalFileSize * phases, done: false};
  var progressTracker = buildmessage.getCurrentProgressTracker();

  // 1. parse
  var toplevel = null,
    sourcesContent = {};

  if (options.spidermonkey) {
    toplevel = UglifyJS.AST_Node.from_mozilla_ast(files);
  } else {
    if (typeof files == "string")
      files = [ files ];
    buildmessage.forkJoin({title: 'minifying: parsing ' + key}, files, function (file) {
      var code = options.fromString
        ? file
        : files.readFile(file, "utf8");
      sourcesContent[file] = code;
      toplevel = UglifyJS.parse(code, {
        filename: options.fromString ? "?" : file,
        toplevel: toplevel
      });

      progress.current += code.length;
      progressTracker.reportProgress(progress);
    });
  }

  // 2. compress
  var compress;
  if (options.compress) buildmessage.enterJob({title: "minify: compress 1 " + key}, function () {
    compress = { warnings: options.warnings };
    UglifyJS.merge(compress, options.compress);
    toplevel.figure_out_scope();
  });
  if (options.compress) buildmessage.enterJob({title: "minify: compress 2 " + key}, function () {
    var sq = UglifyJS.Compressor(compress);
    toplevel = toplevel.transform(sq);

    progress.current += totalFileSize;
    progressTracker.reportProgress(progress);
  });

  // 3. mangle
  if (options.mangle) buildmessage.enterJob({title: "minify: mangling " + key}, function () {
    toplevel.figure_out_scope();
    toplevel.compute_char_frequency();
    toplevel.mangle_names(options.mangle);

    progress.current += totalFileSize;
    progressTracker.reportProgress(progress);
  });

  // 4. output
  var inMap = options.inSourceMap;
  var output = {};
  if (typeof options.inSourceMap == "string") {
    inMap = files.readFile(options.inSourceMap, "utf8");
  }
  if (options.outSourceMap) {
    output.source_map = UglifyJS.SourceMap({
      file: options.outSourceMap,
      orig: inMap,
      root: options.sourceRoot
    });
    if (options.sourceMapIncludeSources) {
      for (var file in sourcesContent) {
        if (sourcesContent.hasOwnProperty(file)) {
          options.source_map.get().setSourceContent(file, sourcesContent[file]);
        }
      }
    }
  }
  if (options.output) buildmessage.enterJob({title: "minify: merging " + key}, function () {
    UglifyJS.merge(output, options.output);

    progress.current += totalFileSize;
    progressTracker.reportProgress(progress);
  });


  var stream;
  buildmessage.enterJob({title: "minify: printing " + key}, function () {
    stream = UglifyJS.OutputStream(output);
    toplevel.print(stream);

    progress.current += totalFileSize;
    progressTracker.reportProgress(progress);
  });

  return {
    code : stream + "",
    map  : output.source_map + ""
  };
};



//////////////////// ClientTarget ////////////////////

var ClientTarget = function (options) {
  var self = this;
  Target.apply(this, arguments);

  // CSS files. List of File. They will be loaded in the order given.
  self.css = [];
  // Cached CSS AST. If non-null, self.css has one item in it, processed CSS
  // from merged input files, and this is its parse tree.
  self._cssAstCache = null;

  // List of segments of additional HTML for <head>/<body>.
  self.head = [];
  self.body = [];

  if (! archinfo.matches(self.arch, "web"))
    throw new Error("ClientTarget targeting something that isn't a client?");
};

util.inherits(ClientTarget, Target);

_.extend(ClientTarget.prototype, {
  // Lints CSS files and merges them into one file, fixing up source maps and
  // pulling any @import directives up to the top since the CSS spec does not
  // allow them to appear in the middle of a file.
  mergeCss: Profile("ClientTarget#mergeCss", function () {
    var self = this;
    var minifiers = isopackets.load('minifiers').minifiers;
    var CssTools = minifiers.CssTools;

    // Filenames passed to AST manipulator mapped to their original files
    var originals = {};

    var cssAsts = _.map(self.css, function (file) {
      var filename = file.url.replace(/^\//, '');
      originals[filename] = file;
      try {
        var parseOptions = { source: filename, position: true };
        var ast = CssTools.parseCss(file.contents('utf8'), parseOptions);
        ast.filename = filename;
      } catch (e) {
        buildmessage.error(e.message, { file: filename });
        return { type: "stylesheet", stylesheet: { rules: [] },
                 filename: filename };
      }

      return ast;
    });

    var warnCb = function (filename, msg) {
      // XXX make this a buildmessage.warning call rather than a random log.
      //     this API would be like buildmessage.error, but wouldn't cause
      //     the build to fail.
      runLog.log(filename + ': warn: ' + msg);
    };

    // Other build phases might need this AST later
    self._cssAstCache = CssTools.mergeCssAsts(cssAsts, warnCb);

    // Overwrite the CSS files list with the new concatenated file
    var stringifiedCss = CssTools.stringifyCss(self._cssAstCache,
                                               { sourcemap: true });
    if (! stringifiedCss.code)
      return;

    self.css = [new File({ info: 'combined css', data: new Buffer(stringifiedCss.code, 'utf8') })];

    // Add the contents of the input files to the source map of the new file
    stringifiedCss.map.sourcesContent =
      _.map(stringifiedCss.map.sources, function (filename) {
        return originals[filename].contents('utf8');
      });

    // If any input files had source maps, apply them.
    // Ex.: less -> css source map should be composed with css -> css source map
    var newMap = sourcemap.SourceMapGenerator.fromSourceMap(
      new sourcemap.SourceMapConsumer(stringifiedCss.map));

    _.each(originals, function (file, name) {
      if (! file.sourceMap)
        return;
      try {
        newMap.applySourceMap(
          new sourcemap.SourceMapConsumer(file.sourceMap), name);
      } catch (err) {
        // If we can't apply the source map, silently drop it.
        //
        // XXX This is here because there are some less files that
        // produce source maps that throw when consumed. We should
        // figure out exactly why and fix it, but this will do for now.
      }
    });

    self.css[0].setSourceMap(JSON.stringify(newMap));
    self.css[0].setUrlToHash(".css");
  }),
  // Minify the CSS in this target
  minifyCss: Profile("ClientTarget#minifyCss", function (minifiers) {
    var self = this;
    var minifiedCss = '';

    // If there is an AST already calculated, don't waste time on parsing it
    // again.
    if (self._cssAstCache) {
      minifiedCss = minifiers.CssTools.minifyCssAst(self._cssAstCache);
    } else if (self.css) {
      var allCss = _.map(self.css, function (file) {
        return file.contents('utf8');
      }).join('\n');

      minifiedCss = minifiers.CssTools.minifyCss(allCss);
    }
    if (!! minifiedCss) {
      self.css = [new File({ info: 'minified css', data: new Buffer(minifiedCss, 'utf8') })];
      self.css[0].setUrlToHash(".css", "?meteor_css_resource=true");
    }
  }),

  // Output the finished target to disk
  //
  // Returns an object with the following keys:
  // - controlFile: the path (relative to 'builder') of the control file for
  // the target
  // - nodePath: an array of paths required to be set in the NODE_PATH
  // environment variable.
  write: Profile("ClientTarget#write", function (builder) {
    var self = this;

    builder.reserve("program.json");

    // Helper to iterate over all resources that we serve over HTTP.
    var eachResource = function (f) {
      _.each(["js", "css", "asset"], function (type) {
        _.each(self[type], function (file) {
          f(file, type);
        });
      });
    };

    // Reserve all file names from the manifest, so that interleaved
    // generateFilename calls don't overlap with them.
    eachResource(function (file, type) {
      builder.reserve(file.targetPath);
    });

    // Build up a manifest of all resources served via HTTP.
    var manifest = [];
    eachResource(function (file, type) {
      var fileContents = file.contents();

      var manifestItem = {
        path: file.targetPath,
        where: "client",
        type: type,
        cacheable: file.cacheable,
        url: file.url
      };

      if (file.sourceMap) {
        // Add anti-XSSI header to this file which will be served over
        // HTTP. Note that the Mozilla and WebKit implementations differ as to
        // what they strip: Mozilla looks for the four punctuation characters
        // but doesn't care about the newline; WebKit only looks for the first
        // three characters (not the single quote) and then strips everything up
        // to a newline.
        // https://groups.google.com/forum/#!topic/mozilla.dev.js-sourcemap/3QBr4FBng5g
        var mapData = new Buffer(")]}'\n" + file.sourceMap, 'utf8');
        manifestItem.sourceMap = builder.writeToGeneratedFilename(
          file.targetPath + '.map', {data: mapData});

        // Use a SHA to make this cacheable.
        var sourceMapBaseName = file.hash() + ".map";
        manifestItem.sourceMapUrl = require('url').resolve(
          file.url, sourceMapBaseName);
      }

      // Set this now, in case we mutated the file's contents.
      manifestItem.size = file.size();
      manifestItem.hash = file.hash();

      writeFile(file, builder);

      manifest.push(manifestItem);
    });

    _.each(['head', 'body'], function (type) {
      var data = self[type].join('\n');
      if (data) {
        var dataBuffer = new Buffer(data, 'utf8');
        var dataFile = builder.writeToGeneratedFilename(
          type + '.html', { data: dataBuffer });
        manifest.push({
          path: dataFile,
          where: 'internal',
          type: type,
          hash: watch.sha1(dataBuffer)
        });
      }
    });

    // Control file
    builder.writeJson('program.json', {
      format: "web-program-pre1",
      manifest: manifest
    });

    return {
      controlFile: "program.json",
      nodePath: []
    };
  })
});


//////////////////// JsImageTarget and JsImage  ////////////////////

// A JsImage (JavaScript Image) is a fully linked JavaScript program
// that is totally ready to go. (Image is used in the sense of "the
// output of a linker", as in "executable image", rather than in the
// sense of "visual picture").
//
// A JsImage can be loaded into its own new JavaScript virtual
// machine, or it can be loaded into an existing virtual machine as a
// plugin.
var JsImage = function () {
  var self = this;

  // Array of objects with keys:
  // - targetPath: relative path to use if saved to disk (or for stack traces)
  // - source: JS source code to load, as a string
  // - nodeModulesDirectory: a NodeModulesDirectory indicating which
  //   directory should be searched by Npm.require()
  // - sourceMap: if set, source map for this code, as a string
  // note: this can't be called `load` at it would shadow `load()`
  self.jsToLoad = [];

  // node_modules directories that we need to copy into the target (or
  // otherwise make available at runtime). A map from an absolute path
  // on disk (NodeModulesDirectory.sourcePath) to a
  // NodeModulesDirectory object that we have created to represent it.
  //
  // The NodeModulesDirectory objects in this map are de-duplicated
  // aliases to the objects in the nodeModulesDirectory fields of
  // the objects in self.jsToLoad.
  self.nodeModulesDirectories = {};

  // Architecture required by this image
  self.arch = null;

  self.providePackageJSONForUnavailableBinaryDeps = false;
};

_.extend(JsImage.prototype, {
  // Load the image into the current process. It gets its own unique
  // Package object containing its own private copy of every
  // isopack that it uses. This Package object is returned.
  //
  // If `bindings` is provided, it is a object containing a set of
  // variables to set in the global environment of the executed
  // code. The keys are the variable names and the values are their
  // values. In addition to the contents of `bindings`, Package and
  // Npm will be provided.
  //
  // XXX throw an error if the image includes any "app-style" code
  // that is built to put symbols in the global namespace rather than
  // in a compartment of Package
  load: Profile("JsImage#load", function (bindings) {
    var self = this;
    var ret = {};

    // XXX This is mostly duplicated from server/boot.js, as is Npm.require
    // below. Some way to avoid this?
    var getAsset = function (assets, assetPath, encoding, callback) {
      assetPath = files.convertToStandardPath(assetPath);
      var fut;
      if (! callback) {
        if (! Fiber.current)
          throw new Error("The synchronous Assets API can " +
                          "only be called from within a Fiber.");
        fut = new Future();
        callback = fut.resolver();
      }
      var _callback = function (err, result) {
        if (result && ! encoding)
          // Sadly, this copies in Node 0.10.
          result = new Uint8Array(result);
        callback(err, result);
      };

      if (!assets || !_.has(assets, assetPath)) {
        _callback(new Error("Unknown asset: " + assetPath));
      } else {
        var buffer = assets[assetPath];
        var result = encoding ? buffer.toString(encoding) : buffer;
        _callback(null, result);
      }
      if (fut)
        return fut.wait();
    };

    // Eval each JavaScript file, providing a 'Npm' symbol in the same
    // way that the server environment would, a 'Package' symbol
    // so the loaded image has its own private universe of loaded
    // packages, and an 'Assets' symbol to help the package find its
    // static assets.
    var failed = false;
    _.each(self.jsToLoad, function (item) {
      if (failed)
        return;

      var env = _.extend({
        Package: ret,
        Npm: {
          require: function (name) {
            if (! item.nodeModulesDirectory) {
              // No Npm.depends associated with this package
              return require(name);
            }

            var nodeModuleDir =
              files.pathJoin(item.nodeModulesDirectory.sourcePath, name);
            var nodeModuleTopDir =
              files.pathJoin(item.nodeModulesDirectory.sourcePath,
                             name.split("/")[0]);

            if (files.exists(nodeModuleTopDir)) {
              return require(files.convertToOSPath(nodeModuleDir));
            }

            try {
              return require(name);
            } catch (e) {
              buildmessage.error(
                "Can't load npm module '" + name + "' from " +
                  item.targetPath + ". Check your Npm.depends().");
              return undefined;
            }
          }
        },

        /**
         * @summary The namespace for Assets functions, lives in the bundler.
         * @namespace
         * @name Assets
         */
        Assets: {

          /**
           * @summary Retrieve the contents of the static server asset as a UTF8-encoded string.
           * @locus Server
           * @memberOf Assets
           * @param {String} assetPath The path of the asset, relative to the application's `private` subdirectory.
           * @param {Function} [asyncCallback] Optional callback, which is called asynchronously with the error or result after the function is complete. If not provided, the function runs synchronously.
           */
          getText: function (assetPath, callback) {
            return getAsset(item.assets, assetPath, "utf8", callback);
          },

          /**
           * @summary Retrieve the contents of the static server asset as an [EJSON Binary](#ejson_new_binary).
           * @locus Server
           * @memberOf Assets
           * @param {String} assetPath The path of the asset, relative to the application's `private` subdirectory.
           * @param {Function} [asyncCallback] Optional callback, which is called asynchronously with the error or result after the function is complete. If not provided, the function runs synchronously.
           */
          getBinary: function (assetPath, callback) {
            return getAsset(item.assets, assetPath, undefined, callback);
          }
        }
      }, bindings || {});

      try {
        // XXX XXX Get the actual source file path -- item.targetPath
        // is not actually correct (it's the path in the bundle rather
        // than in the source tree).
        files.runJavaScript(item.source.toString('utf8'), {
          filename: item.targetPath,
          symbols: env,
          sourceMap: item.sourceMap,
          sourceMapRoot: item.sourceMapRoot
        });
      } catch (e) {
        buildmessage.exception(e);
        // Recover by skipping the rest of the load
        failed = true;
        return;
      }
    });

    return ret;
  }),

  // Write this image out to disk
  //
  // options:
  // - includeNodeModules: falsy or 'symlink' or 'reference-directly'.
  //   Documented on exports.bundle.
  //
  // Returns an object with the following keys:
  // - controlFile: the path (relative to 'builder') of the control file for
  // the image
  // - nodePath: an array of paths required to be set in the NODE_PATH
  // environment variable.
  write: Profile("JsImage#write", function (builder, options) {
    var self = this;
    options = options || {};

    builder.reserve("program.json");

    // Finalize choice of paths for node_modules directories -- These
    // paths are no longer just "preferred"; they are the final paths
    // that we will use
    var nodeModulesDirectories = [];
    _.each(self.nodeModulesDirectories || [], function (nmd) {
      // We do a little manipulation to make sure that generateFilename only
      // adds suffixes to parts of the path other than the final node_modules,
      // which needs to stay node_modules.
      var dirname = files.pathDirname(nmd.preferredBundlePath);
      var base = files.pathBasename(nmd.preferredBundlePath);
      var generatedDir = builder.generateFilename(dirname, {directory: true});

      // We need to find the actual file system location for the node modules
      // this JS Image uses, so that we can add it to nodeModulesDirectories
      var modulesPhysicalLocation;
      if (! options.includeNodeModules ||
          options.includeNodeModules === 'symlink') {
        modulesPhysicalLocation = files.pathJoin(generatedDir, base);
      } else if (options.includeNodeModules === 'reference-directly') {
        modulesPhysicalLocation = nmd.sourcePath;
      } else {
        // This is some option we didn't expect - someone has added another case
        // to the includeNodeModules option but didn't update this if block.
        // Fail hard.
        throw new Error("Option includeNodeModules wasn't falsy, 'symlink', " +
          "or 'reference-directly'. It was: " + options.includeNodeModules);
      }

      nodeModulesDirectories.push(new NodeModulesDirectory({
        sourcePath: nmd.sourcePath,
        preferredBundlePath: modulesPhysicalLocation,
        npmDiscards: nmd.npmDiscards,
        writePackageJSON: nmd.writePackageJSON
      }));
    });

    // If multiple load files share the same asset, only write one copy of
    // each. (eg, for app assets).
    var assetFilesBySha = {};

    // JavaScript sources
    var load = [];
    _.each(self.jsToLoad, function (item) {
      if (! item.targetPath)
        throw new Error("No targetPath?");

      var loadItem = {};

      if (item.nodeModulesDirectory) {
        // We need to make sure to use the directory name we got from
        // builder.generateFilename here.
        // XXX these two parallel data structures of self.jsToLoad and
        //     self.nodeModulesDirectories are confusing
        var generatedNMD = _.findWhere(
          nodeModulesDirectories,
          {sourcePath: item.nodeModulesDirectory.sourcePath}
        );
        if (generatedNMD) {
          loadItem.node_modules = generatedNMD.preferredBundlePath;
        }
      }

      if (item.sourceMap) {
        // Reference the source map in the source. Looked up later by
        // node-inspector.
        var sourceMapBaseName = item.targetPath + ".map";

        // Write the source map.
        loadItem.sourceMap = builder.writeToGeneratedFilename(
          sourceMapBaseName,
          { data: new Buffer(item.sourceMap, 'utf8') }
        );

        var sourceMapFileName = files.pathBasename(loadItem.sourceMap);
        // Remove any existing sourceMappingURL line. (eg, if roundtripping
        // through JsImage.readFromDisk, don't end up with two!)
        item.source = item.source.replace(
            /\n\/\/# sourceMappingURL=.+\n?$/g, '');
        item.source += "\n//# sourceMappingURL=" + sourceMapFileName + "\n";
        loadItem.sourceMapRoot = item.sourceMapRoot;
      }

      loadItem.path = builder.writeToGeneratedFilename(
        item.targetPath,
        { data: new Buffer(item.source, 'utf8') });

      if (!_.isEmpty(item.assets)) {
        // For package code, static assets go inside a directory inside
        // assets/packages specific to this package. Application assets (e.g. those
        // inside private/) go in assets/app/.
        // XXX same hack as setTargetPathFromRelPath
          var assetBundlePath;
        if (item.targetPath.match(/^packages\//)) {
          var dir = files.pathDirname(item.targetPath);
          var base = files.pathBasename(item.targetPath, ".js");
          assetBundlePath = files.pathJoin('assets', dir, base);
        } else {
          assetBundlePath = files.pathJoin('assets', 'app');
        }

        loadItem.assets = {};
        _.each(item.assets, function (data, relPath) {
          var sha = watch.sha1(data);
          if (_.has(assetFilesBySha, sha)) {
            loadItem.assets[relPath] = assetFilesBySha[sha];
          } else {
            loadItem.assets[relPath] = assetFilesBySha[sha] =
              builder.writeToGeneratedFilename(
                files.pathJoin(assetBundlePath, relPath), { data: data });
          }
        });
      }

      load.push(loadItem);
    });

    var setupScriptPieces = [];
    // node_modules resources from the packages. Due to appropriate
    // builder configuration, 'meteor bundle' and 'meteor deploy' copy
    // them, and 'meteor run' symlinks them. If these contain
    // arch-specific code then the target will end up having an
    // appropriately specific arch.
    _.each(nodeModulesDirectories, function (nmd) {
      if (nmd.writePackageJSON) {
        // Make sure there's an empty node_modules directory at the right place
        // in the tree (so that npm install puts modules there instead of
        // elsewhere).
        builder.reserve(
          nmd.preferredBundlePath, {directory: true});
        // We check that these source files exist in _emitResources when
        // writePackageJSON is initially set.
        builder.write(
          files.pathJoin(files.pathDirname(nmd.preferredBundlePath),
                         'package.json'),
          { file: files.pathJoin(nmd.sourcePath, '.package.json') }
        );
        builder.write(
          files.pathJoin(files.pathDirname(nmd.preferredBundlePath),
                         'npm-shrinkwrap.json'),
          { file: files.pathJoin(nmd.sourcePath, '.npm-shrinkwrap.json') }
        );
        // XXX does not support npmDiscards!

        setupScriptPieces.push(
          '(cd ', nmd.preferredBundlePath, ' && npm install)\n\n');
      } else if (nmd.sourcePath !== nmd.preferredBundlePath) {
        builder.copyDirectory({
          from: nmd.sourcePath,
          to: nmd.preferredBundlePath,
          npmDiscards: nmd.npmDiscards,
          symlink: (options.includeNodeModules === 'symlink')
        });
      }
    });

    if (setupScriptPieces.length) {
      setupScriptPieces.unshift('#!/bin/bash\n', 'set -e\n\n');
      builder.write('setup.sh', {
        data: new Buffer(setupScriptPieces.join(''), 'utf8'),
        executable: true
      });
    }

    // Control file
    builder.writeJson('program.json', {
      format: "javascript-image-pre1",
      arch: self.arch,
      load: load
    });

    return {
      controlFile: "program.json",
      nodePath: []
    };
  })
});

// Create a JsImage by loading a bundle of format
// 'javascript-image-pre1' from disk (eg, previously written out with
// write()). `dir` is the path to the control file.
JsImage.readFromDisk = Profile("JsImage.readFromDisk", function (controlFilePath) {
  var ret = new JsImage;
  var json = JSON.parse(files.readFile(controlFilePath));
  var dir = files.pathDirname(controlFilePath);

  if (json.format !== "javascript-image-pre1")
    throw new Error("Unsupported plugin format: " +
                    JSON.stringify(json.format));

  ret.arch = json.arch;

  _.each(json.load, function (item) {
    rejectBadPath(item.path);

    var nmd = undefined;
    if (item.node_modules) {
      rejectBadPath(item.node_modules);
      var node_modules = files.pathJoin(dir, item.node_modules);
      if (! (node_modules in ret.nodeModulesDirectories)) {
        ret.nodeModulesDirectories[node_modules] =
          new NodeModulesDirectory({
            sourcePath: node_modules,
            preferredBundlePath: item.node_modules
            // No npmDiscards, because we should have already discarded things
            // when writing the image to disk.
          });
      }
      nmd = ret.nodeModulesDirectories[node_modules];
    }

    var loadItem = {
      targetPath: item.path,
      source: files.readFile(files.pathJoin(dir, item.path), 'utf8'),
      nodeModulesDirectory: nmd
    };

    if (item.sourceMap) {
      // XXX this is the same code as isopack.initFromPath
      rejectBadPath(item.sourceMap);
      loadItem.sourceMap = files.readFile(
        files.pathJoin(dir, item.sourceMap), 'utf8');
      loadItem.sourceMapRoot = item.sourceMapRoot;
    }

    if (!_.isEmpty(item.assets)) {
      loadItem.assets = {};
      _.each(item.assets, function (filename, relPath) {
        loadItem.assets[relPath] = files.readFile(files.pathJoin(dir, filename));
      });
    }

    ret.jsToLoad.push(loadItem);
  });

  return ret;
});

var JsImageTarget = function (options) {
  var self = this;
  Target.apply(this, arguments);

  if (! archinfo.matches(self.arch, "os"))
    // Conceivably we could support targeting the client as long as
    // no native node modules were used.  No use case for that though.
    throw new Error("JsImageTarget targeting something unusual?");
};

util.inherits(JsImageTarget, Target);

_.extend(JsImageTarget.prototype, {
  toJsImage: function () {
    var self = this;
    var ret = new JsImage;

    _.each(self.js, function (file) {
      ret.jsToLoad.push({
        targetPath: file.targetPath,
        source: file.contents().toString('utf8'),
        nodeModulesDirectory: file.nodeModulesDirectory,
        assets: file.assets,
        sourceMap: file.sourceMap,
        sourceMapRoot: file.sourceMapRoot
      });
    });

    ret.nodeModulesDirectories = self.nodeModulesDirectories;
    ret.arch = self.mostCompatibleArch();

    return ret;
  }
});


//////////////////// ServerTarget ////////////////////

// options specific to this subclass:
// - clientTarget: the ClientTarget to serve up over HTTP as our client
// - releaseName: the Meteor release name (for retrieval at runtime)
var ServerTarget = function (options) {
  var self = this;
  JsImageTarget.apply(this, arguments);

  self.clientTargets = options.clientTargets;
  self.releaseName = options.releaseName;

  if (! archinfo.matches(self.arch, "os"))
    throw new Error("ServerTarget targeting something that isn't a server?");
};

util.inherits(ServerTarget, JsImageTarget);

_.extend(ServerTarget.prototype, {
  // Output the finished target to disk
  // options:
  // - includeNodeModules: falsy, 'symlink' or 'reference-directly',
  //   documented in exports.bundle
  // - getRelativeTargetPath: a function that takes {forTarget:
  //   Target, relativeTo: Target} and return the path of one target
  //   in the bundle relative to another. hack to get the path of the
  //   client target.. we'll find a better solution here eventually
  //
  // Returns the path (relative to 'builder') of the control file for
  // the plugin and the required NODE_PATH.
  write: Profile("ServerTarget#write", function (builder, options) {
    var self = this;
    var nodePath = [];

    // This is where the dev_bundle will be downloaded and unpacked
    builder.reserve('dependencies');

    // Mapping from arch to relative path to the client program, if we have any
    // (hack). Ex.: { 'web.browser': '../web.browser/program.json', ... }
    var clientTargetPaths = {};
    if (self.clientTargets) {
      _.each(self.clientTargets, function (target) {
        clientTargetPaths[target.arch] = files.pathJoin(options.getRelativeTargetPath({
          forTarget: target, relativeTo: self}), 'program.json');
      });
    }

    // We will write out config.json, the dependency kit, and the
    // server driver alongside the JsImage
    builder.writeJson("config.json", {
      meteorRelease: self.releaseName || undefined,
      clientPaths: clientTargetPaths
    });

    // Write package.json and npm-shrinkwrap.json for the dependencies of
    // boot.js.
    builder.write('package.json', {
      file: files.pathJoin(files.getDevBundle(), 'etc', 'package.json')
    });
    builder.write('npm-shrinkwrap.json', {
      file: files.pathJoin(files.getDevBundle(), 'etc', 'npm-shrinkwrap.json')
    });

    // This is a hack to make 'meteor run' faster (so you don't have to run 'npm
    // install' using the above package.json and npm-shrinkwrap.json on every
    // rebuild).
    if (options.includeNodeModules === 'symlink') {
      builder.write('node_modules', {
        symlink: files.pathJoin(files.getDevBundle(), 'server-lib', 'node_modules')
      });
    } else if (options.includeNodeModules === 'reference-directly') {
      nodePath.push(
        files.pathJoin(files.getDevBundle(), 'server-lib', 'node_modules')
      );
    } else if (options.includeNodeModules) {
      // This is some option we didn't expect - someone has added another case
      // to the includeNodeModules option but didn't update this if block. Fail
      // hard.
      throw new Error("Option includeNodeModules wasn't falsy, 'symlink', " +
        "or 'reference-directly'.");
    }

    // Linked JavaScript image (including static assets, assuming that there are
    // any JS files at all)
    var jsImage = self.toJsImage();
    jsImage.write(builder, { includeNodeModules: options.includeNodeModules });

    // Server bootstrap
    _.each([
      "boot.js",
      "boot-utils.js",
      "shell-server.js",
      "mini-files.js",
    ], function (filename) {
      builder.write(filename, {
        file: files.pathJoin(
          files.convertToStandardPath(__dirname),
          "server",
          filename
        )
      });
    });

    // Script that fetches the dev_bundle and runs the server bootstrap
    // XXX this is #GalaxyLegacy, the generated start.sh is not really used by
    // anything anymore
    var archToPlatform = {
      'os.linux.x86_32': 'Linux_i686',
      'os.linux.x86_64': 'Linux_x86_64',
      'os.osx.x86_64': 'Darwin_x86_64',
      'os.windows.x86_32': 'Windows_x86_32'
    };
    var platform = archToPlatform[self.arch];
    if (! platform) {
      throw new Error("MDG does not publish dev_bundles for arch: " +
                         self.arch);
    }

    // Nothing actually pays attention to the `path` field for a server program
    // in star.json any more, so it might as well be boot.js. (It used to be
    // start.sh, a script included for the legacy Galaxy prototype.)
    var controlFilePath = 'boot.js';
    return {
      controlFile: controlFilePath,
      nodePath: nodePath
    };
  })
});

var writeFile = Profile("bundler..writeFile", function (file, builder) {
  if (! file.targetPath)
    throw new Error("No targetPath?");
  var contents = file.contents();
  if (! (contents instanceof Buffer))
    throw new Error("contents not a Buffer?");
  // XXX should probably use sanitize: true, but that will have
  // to wait until the server is actually driven by the manifest
  // (rather than just serving all of the files in a certain
  // directories)
  builder.write(file.targetPath, { data: file.contents() });
});

// Writes a target a path in 'programs'
var writeTargetToPath = Profile(
  "bundler..writeTargetToPath", function (name, target, outputPath, options) {
  var builder = new Builder({
    outputPath: files.pathJoin(outputPath, 'programs', name)
  });

  var targetBuild =
    target.write(builder, {
      includeNodeModules: options.includeNodeModules,
      getRelativeTargetPath: options.getRelativeTargetPath });

  builder.complete();

  return {
    name: name,
    arch: target.mostCompatibleArch(),
    path: files.pathJoin('programs', name, targetBuild.controlFile),
    nodePath: targetBuild.nodePath,
    cordovaDependencies: target.cordovaDependencies || undefined
  };
});

///////////////////////////////////////////////////////////////////////////////
// writeSiteArchive
///////////////////////////////////////////////////////////////////////////////

// targets is a set of Targets to include in the bundle, as a map from
// target name (to use in the bundle) to a Target. outputPath is the
// path of a directory that should be created to contain the generated
// site archive.
//
// Returns:

// {
//     clientWatchSet: watch.WatchSet for all files and directories that
//                     ultimately went into all client programs
//     serverWatchSet: watch.WatchSet for all files and directories that
//                     ultimately went into all server programs
//     starManifest: the JSON manifest of the star
//     nodePath: an array of paths required to be set in NODE_PATH. It's
//               up to the called to determine what they should be.
// }
//
// options:
// - includeNodeModules: string or falsy, documented on exports.bundle
// - builtBy: vanity identification string to write into metadata
// - releaseName: The Meteor release version
// - getRelativeTargetPath: see doc at ServerTarget.write
var writeSiteArchive = Profile(
  "bundler..writeSiteArchive", function (targets, outputPath, options) {
  var builder = new Builder({
    outputPath: outputPath
  });

  try {
    var json = {
      format: "site-archive-pre1",
      builtBy: options.builtBy,
      programs: [],
      meteorRelease: options.releaseName
    };
    var nodePath = [];

    // Tell the deploy server what version of the dependency kit we're using, so
    // it can load the right modules. (Include this even if we copied or
    // symlinked a node_modules, since that's probably enough for it to work in
    // spite of the presence of node_modules for the wrong arch). The place we
    // stash this is grody for temporary reasons of backwards compatibility.
    builder.write(files.pathJoin('server', '.bundle_version.txt'), {
      file: files.pathJoin(files.getDevBundle(), '.bundle_version.txt')
    });

    // Affordances for standalone use
    if (targets.server) {
      // add program.json as the first argument after "node main.js" to the boot script.
      builder.write('main.js', {
        data: new Buffer(exports._mainJsContents, 'utf8')
      });

      builder.write('README', { data: new Buffer(
"This is a Meteor application bundle. It has only one external dependency:\n" +
"Node.js 0.10.36 or newer. To run the application:\n" +
"\n" +
"  $ (cd programs/server && npm install)\n" +
"  $ export MONGO_URL='mongodb://user:password@host:port/databasename'\n" +
"  $ export ROOT_URL='http://example.com'\n" +
"  $ export MAIL_URL='smtp://user:password@mailhost:port/'\n" +
"  $ node main.js\n" +
"\n" +
"Use the PORT environment variable to set the port where the\n" +
"application will listen. The default is 80, but that will require\n" +
"root on most systems.\n" +
"\n" +
"Find out more about Meteor at meteor.com.\n",
      'utf8')});
    }

    // Merge the WatchSet of everything that went into the bundle.
    var clientWatchSet = new watch.WatchSet();
    var serverWatchSet = new watch.WatchSet();
    var dependencySources = [builder].concat(_.values(targets));
    _.each(dependencySources, function (s) {
      if (s instanceof ClientTarget) {
        clientWatchSet.merge(s.getWatchSet());
      } else {
        serverWatchSet.merge(s.getWatchSet());
      }
    });

    _.each(targets, function (target, name) {
      var targetBuild = writeTargetToPath(name, target, builder.buildPath, {
        includeNodeModules: options.includeNodeModules,
        builtBy: options.builtBy,
        releaseName: options.releaseName,
        getRelativeTargetPath: options.getRelativeTargetPath
      });

      json.programs.push(targetBuild);
      nodePath = nodePath.concat(targetBuild.nodePath);
    });

    // Control file
    builder.writeJson('star.json', json);

    // We did it!
    builder.complete();

    return {
      clientWatchSet: clientWatchSet,
      serverWatchSet: serverWatchSet,
      starManifest: json,
      nodePath: nodePath
    };
  } catch (e) {
    builder.abort();
    throw e;
  }
});

///////////////////////////////////////////////////////////////////////////////
// Main
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds a Meteor app.
 *
 * options are:
 *
 * - projectContext: Required. The project to build (ProjectContext object).
 *
 * - outputPath: Required. Path to the directory where the output (an
 *   untarred bundle) should go. This directory will be created if it
 *   doesn't exist, and removed first if it does exist.
 *
 * - includeNodeModules: specifies how node_modules for program should be
 *   included:
 *   + false/null/undefined - don't include node_modules
 *   + 'symlink' - we create a symlink from programs/server/node_modules to the
 *   dev bundle's server-lib/node_modules.  This is a hack to make 'meteor run'
 *   faster. (It is preferred on systems with symlinks as we can't just set
 *   $NODE_PATH because then random node_modules directories above cwd take
 *   precedence.) To make it even hackier, this also means we make node_modules
 *   directories for packages symlinks instead of copies.
 *   + 'reference-directly' - don't copy the files of node modules.
 *   Instead, use paths directly to files we already have on the file-system: in
 *   package catalog, isopacks folder or the dev_bundle folder.
 *   return the NODE_PATH string with the resulting bundle that would be set as
 *   the NODE_PATH environment variable when the node process is running. (The
 *   fallback option for Windows). For isopacks (meteor packages), link to the
 *   location of the locally stored isopack build (e.g.
 *   ~/.meteor/packages/package/version/npm)
 *
 * - buildOptions: may include
 *   - minify: minify the CSS and JS assets (boolean, default false)
 *   - serverArch: the server architecture to target (string, default
 *     archinfo.host())
 *   - includeDebug: include packages marked debugOnly (boolean, default false)
 *   - webArchs: array of 'web.*' options to build (defaults to
 *     projectContext.platformList.getWebArchs())
 *
 * - hasCachedBundle: true if we already have a cached bundle stored in
 *   /build. When true, we only build the new client targets in the bundle.
 *
 * Returns an object with keys:
 * - errors: A buildmessage.MessageSet, or falsy if bundling succeeded.
 * - serverWatchSet: Information about server files and paths that were
 *   inputs into the bundle and that we may wish to monitor for
 *   changes when developing interactively, as a watch.WatchSet.
 * - clientWatchSet: Like 'serverWatchSet', but for client files
 * - starManifest: The manifest of the outputted star
 *
 * On failure ('errors' is truthy), no bundle will be output (in fact,
 * outputPath will have been removed if it existed).
 *
 * The currently running version of Meteor (release.current) must
 * match the version called for by the app (unless release.forced is
 * true, meaning that the user explicitly forced us to use this
 * release).
 *
 * Note that when you run "meteor test-packages", appDir points to the
 * test harness, while the local package search paths in 'release'
 * will point somewhere else -- into the app (if any) whose packages
 * you are testing!
 */
exports.bundle = function (options) {
  var projectContext = options.projectContext;

  var outputPath = options.outputPath;
  var includeNodeModules = options.includeNodeModules;
  var buildOptions = options.buildOptions || {};
  var providePackageJSONForUnavailableBinaryDeps = options.providePackageJSONForUnavailableBinaryDeps;
  
  var appDir = projectContext.projectDir;

  var serverArch = buildOptions.serverArch || archinfo.host();
  var webArchs = buildOptions.webArchs ||
        projectContext.platformList.getWebArchs();

  var releaseName =
    release.current.isCheckout() ? "none" : release.current.name;
  var builtBy = "Meteor" + (release.current.name ?
                            " " + release.current.name : "");

  var success = false;
  var serverWatchSet = new watch.WatchSet();
  var clientWatchSet = new watch.WatchSet();
  var starResult = null;
  var targets = {};
  var nodePath = [];

  if (! release.usingRightReleaseForApp(projectContext))
    throw new Error("running wrong release for app?");

  var messages = buildmessage.capture({
    title: "building the application"
  }, function () {
    var makeClientTarget = Profile(
      "bundler.bundle..makeClientTarget", function (app, webArch) {
      var client = new ClientTarget({
        packageMap: projectContext.packageMap,
        isopackCache: projectContext.isopackCache,
        arch: webArch,
        cordovaPluginsFile: (webArch === 'web.cordova'
                             ? projectContext.cordovaPluginsFile : null),
        includeDebug: buildOptions.includeDebug
      });

      client.make({
        packages: [app],
        minify: buildOptions.minify,
        addCacheBusters: true
      });

      return client;
    });

    var makeServerTarget = Profile(
      "bundler.bundle..makeServerTarget", function (app, clientTargets) {
      var targetOptions = {
        packageMap: projectContext.packageMap,
        isopackCache: projectContext.isopackCache,
        arch: serverArch,
        releaseName: releaseName,
        includeDebug: buildOptions.includeDebug,
        providePackageJSONForUnavailableBinaryDeps: providePackageJSONForUnavailableBinaryDeps
      };
      if (clientTargets)
        targetOptions.clientTargets = clientTargets;

      var server = new ServerTarget(targetOptions);

      server.make({
        packages: [app],
        minify: false
      });

      return server;
    });

    // Create a Isopack object that represents the app
    // XXX should this be part of prepareProjectForBuild and get cached?
    //     at the very least, would speed up deploy after build.
    var packageSource = new PackageSource;
    packageSource.initFromAppDir(projectContext, exports.ignoreFiles);
    var app = compiler.compile(packageSource, {
      packageMap: projectContext.packageMap,
      isopackCache: projectContext.isopackCache,
      includeCordovaUnibuild: projectContext.platformList.usesCordova()
    });

    var clientTargets = [];
    // Client
    _.each(webArchs, function (arch) {
      var client = makeClientTarget(app, arch);
      clientTargets.push(client);
      targets[arch] = client;
    });

    // Server
    if (! options.hasCachedBundle) {
      var server = makeServerTarget(app, clientTargets);
      targets.server = server;
    }

    // Hack to let servers find relative paths to clients. Should find
    // another solution eventually (probably some kind of mount
    // directive that mounts the client bundle in the server at runtime)
    var getRelativeTargetPath = function (options) {
      var pathForTarget = function (target) {
        var name;
        _.each(targets, function (t, n) {
          if (t === target)
            name = n;
        });
        if (! name)
          throw new Error("missing target?");
        return files.pathJoin('programs', name);
      };

      return files.pathRelative(pathForTarget(options.relativeTo),
                                pathForTarget(options.forTarget));
    };

    // Write to disk
    var writeOptions = {
      includeNodeModules: includeNodeModules,
      builtBy: builtBy,
      releaseName: releaseName,
      getRelativeTargetPath: getRelativeTargetPath
    };

    if (options.hasCachedBundle) {
      // If we already have a cached bundle, just recreate the new targets.
      // XXX This might make the contents of "star.json" out of date.
      _.each(targets, function (target, name) {
        var targetBuild =
          writeTargetToPath(name, target, outputPath, writeOptions);
        nodePath = nodePath.concat(targetBuild.nodePath);
        clientWatchSet.merge(target.getWatchSet());
      });
    } else {
      starResult = writeSiteArchive(targets, outputPath, writeOptions);
      nodePath = nodePath.concat(starResult.nodePath);
      serverWatchSet.merge(starResult.serverWatchSet);
      clientWatchSet.merge(starResult.clientWatchSet);
    }

    success = true;
  });

  if (success && messages.hasMessages())
    success = false; // there were errors

  return {
    errors: success ? false : messages,
    serverWatchSet: serverWatchSet,
    clientWatchSet: clientWatchSet,
    starManifest: starResult && starResult.starManifest,
    nodePath: nodePath
  };
};

// Make a JsImage object (a complete, linked, ready-to-go JavaScript
// program). It can either be loaded into memory with load(), which
// returns the `Package` object inside the plugin's namespace, or
// saved to disk with write(builder).
//
// Returns an object with keys:
// - image: The created JsImage object.
// - watchSet: Source file WatchSet (see bundle()).
// - usedPackageNames: array of names of packages that are used
//
// XXX return an 'errors' key for symmetry with bundle(), rather than
// letting exceptions escape?
//
// options:
// - packageMap: required. the PackageMap for resolving
//   bundle-time dependencies
// - isopackCache: required. IsopackCache with all dependent packages
//   loaded
// - name: required. a name for this image (cosmetic, but will appear
//   in, eg, error messages) -- technically speaking, this is the name
//   of the package created to contain the sources and package
//   dependencies set up below
// - use: list of packages to use in the plugin, as strings (foo or foo.bar)
// - sources: source files to use (paths on local disk)
// - sourceRoot: path relative to which sources should be
//   interpreted. please set it to something reasonable so that any error
//   messages will look pretty.
// - npmDependencies: map from npm package name to required version
// - npmDir: where to keep the npm cache and npm version shrinkwrap
//   info. required if npmDependencies present.
//
// XXX currently any symbols exported by the plugin will get mapped
// into 'Package.<plugin name>' within the plugin, so name should not
// be the name of any package that is included (directly or
// transitively) in the plugin build. obviously this is unfortunate.
// It would be nice to have a way to say "make this package anonymous"
// without also saying "make its namespace the same as the global
// namespace." It should be an easy refactor,
exports.buildJsImage = Profile("bundler.buildJsImage", function (options) {
  buildmessage.assertInCapture();
  if (options.npmDependencies && ! options.npmDir)
    throw new Error("Must indicate .npm directory to use");
  if (! options.name)
    throw new Error("Must provide a name");

  var packageSource = new PackageSource;

  packageSource.initFromOptions(options.name, {
    kind: "plugin",
    use: options.use || [],
    sourceRoot: options.sourceRoot,
    sources: options.sources || [],
    // it is correct to set slash and not files.pathSep because serverRoot is a
    // url path and not a file system path
    serveRoot: '/',
    npmDependencies: options.npmDependencies,
    npmDir: options.npmDir
  });

  var isopack = compiler.compile(packageSource, {
    packageMap: options.packageMap,
    isopackCache: options.isopackCache,
    // There's no web.cordova unibuild here anyway, just os.
    includeCordovaUnibuild: false
  });

  var target = new JsImageTarget({
    packageMap: options.packageMap,
    isopackCache: options.isopackCache,
    // This function does not yet support cross-compilation (neither does
    // initFromOptions). That's OK for now since we're only trying to support
    // cross-bundling, not cross-package-building, and this function is only
    // used to build plugins (during package build) and for isopack.load
    // (which always wants to build for the current host).
    arch: archinfo.host()
  });
  target.make({ packages: [isopack] });

  return {
    image: target.toJsImage(),
    watchSet: target.getWatchSet(),
    usedPackageNames: _.keys(target.usedPackages)
  };
});

// Load a JsImage from disk (that was previously written by calling
// write() on a JsImage). `controlFilePath` is the path to the control
// file (eg, program.json).
exports.readJsImage = Profile(
  "bundler.readJsImage", function (controlFilePath) {
  return JsImage.readFromDisk(controlFilePath);
});