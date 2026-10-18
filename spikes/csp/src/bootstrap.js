// Runs before the application bundle, like an Angular `polyfills` entry. Monaco reads
// `MonacoEnvironment` and creates its Trusted Types policies while its modules are evaluated, and
// it creates <style> elements as soon as an editor exists, so both hooks must be installed by a
// script that finishes before the main bundle (and the shared chunks it imports) starts.
import './style-nonce.js';
import './monaco-env.js';
