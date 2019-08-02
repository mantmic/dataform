import { createGenIndexConfig } from "@dataform/api/vm/gen_index_config";
import { compiler, indexFileGenerator } from "@dataform/core";
import * as path from "path";
import { NodeVM } from "vm2";

export function compile(query: string, projectDir?: string, defaultSchema?: string): string {
  let compiledQuery = query;
  if (projectDir) {
    const vm = new NodeVM({
      wrapper: "none",
      require: {
        context: "sandbox",
        root: projectDir,
        external: true
      },
      sourceExtensions: ["js", "sql"],
      compiler: (code, path) => compiler(code, path, defaultSchema)
    });
    // This use of genIndex needs some rethinking. It uses the version built into
    // @dataform/api instead of @dataform/core, which would be more correct, as done in compile.ts.
    // Possibly query compilation as a whole needs a redesign.
    const indexScript = indexFileGenerator(
      createGenIndexConfig(
        { projectDir },
        `(function() {
        require("@dataform/core");
        const ref = global.session.resolve.bind(session);
        const resolve = global.session.resolve.bind(session);
        const noop = () => "";
        const config = noop;
        const type = noop;
        const postOps = noop;
        const preOps = noop;
        const self = noop;
        const dependencies = noop;
        const where = noop;
        const descriptor = noop;
        const describe = field => field;
        return \`${query}\`;
      })()`
      )
    );
    compiledQuery = vm.run(indexScript, path.resolve(path.join(projectDir, "index.js")));
  }
  return compiledQuery;
}

process.on(`message`, object => {
  try {
    const graph = compile(object.query, object.projectDir, object.defaultSchema);
    process.send({ result: graph });
  } catch (e) {
    process.send({ err: String(e) });
  }
  process.exit();
});
