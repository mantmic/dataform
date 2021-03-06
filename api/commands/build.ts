import { Credentials } from "df/api/commands/credentials";
import { prune } from "df/api/commands/prune";
import { state } from "df/api/commands/state";
import * as dbadapters from "df/api/dbadapters";
import { adapters } from "df/core";
import * as utils from "df/core/utils";
import { dataform } from "df/protos/ts";

export async function build(
  compiledGraph: dataform.ICompiledGraph,
  runConfig: dataform.IRunConfig,
  dbadapter: dbadapters.IDbAdapter
) {
  const prunedGraph = prune(compiledGraph, runConfig);
  const stateResult = await state(prunedGraph, dbadapter);
  return new Builder(prunedGraph, runConfig, stateResult).build();
}

export class Builder {
  private compiledGraph: dataform.ICompiledGraph;
  private runConfig: dataform.IRunConfig;

  private adapter: adapters.IAdapter;
  private warehouseState: dataform.IWarehouseState;

  constructor(
    compiledGraph: dataform.ICompiledGraph,
    runConfig: dataform.IRunConfig,
    warehouseState: dataform.IWarehouseState
  ) {
    this.compiledGraph = compiledGraph;
    this.runConfig = runConfig;
    this.warehouseState = warehouseState;
    this.adapter = adapters.create(
      compiledGraph.projectConfig,
      compiledGraph.dataformCoreVersion || "1.0.0"
    );
  }

  public build(): dataform.ExecutionGraph {
    if (utils.graphHasErrors(this.compiledGraph)) {
      throw new Error(`Project has unresolved compilation or validation errors.`);
    }

    const tableStateByTarget: { [targetJson: string]: dataform.ITableMetadata } = {};
    this.warehouseState.tables.forEach(tableState => {
      tableStateByTarget[JSON.stringify(tableState.target)] = tableState;
    });

    const actions: dataform.IExecutionAction[] = [].concat(
      this.compiledGraph.tables.map(t =>
        this.buildTable(t, tableStateByTarget[JSON.stringify(t.target)])
      ),
      this.compiledGraph.operations.map(o => this.buildOperation(o)),
      this.compiledGraph.assertions.map(a => this.buildAssertion(a))
    );
    return dataform.ExecutionGraph.create({
      projectConfig: this.compiledGraph.projectConfig,
      runConfig: {
        ...this.runConfig,
        useRunCache:
          !this.runConfig.hasOwnProperty("useRunCache") ||
          typeof this.runConfig.useRunCache === "undefined"
            ? this.compiledGraph.projectConfig.useRunCache
            : this.runConfig.useRunCache
      },
      warehouseState: this.warehouseState,
      actions
    });
  }

  public buildTable(t: dataform.ITable, tableMetadata: dataform.ITableMetadata) {
    if (t.protected && this.runConfig.fullRefresh) {
      throw new Error("Protected datasets cannot be fully refreshed.");
    }

    const tasks = t.disabled
      ? ([] as dataform.IExecutionTask[])
      : this.adapter.publishTasks(t, this.runConfig, tableMetadata).build();

    return dataform.ExecutionAction.create({
      name: t.name,
      dependencyTargets: t.dependencyTargets,
      dependencies: t.dependencies,
      type: "table",
      target: t.target,
      tableType: t.type,
      tasks,
      fileName: t.fileName,
      actionDescriptor: t.actionDescriptor
    });
  }

  public buildOperation(operation: dataform.IOperation) {
    return dataform.ExecutionAction.create({
      name: operation.name,
      dependencyTargets: operation.dependencyTargets,
      dependencies: operation.dependencies,
      type: "operation",
      target: operation.target,
      tasks: operation.queries.map(statement => ({ type: "statement", statement })),
      fileName: operation.fileName,
      actionDescriptor: operation.actionDescriptor
    });
  }

  public buildAssertion(assertion: dataform.IAssertion) {
    return dataform.ExecutionAction.create({
      name: assertion.name,
      dependencyTargets: assertion.dependencyTargets,
      dependencies: assertion.dependencies,
      type: "assertion",
      target: assertion.target,
      tasks: this.adapter.assertTasks(assertion, this.compiledGraph.projectConfig).build(),
      fileName: assertion.fileName,
      actionDescriptor: assertion.actionDescriptor
    });
  }
}
