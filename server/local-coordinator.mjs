import { commitWorkflowMutationDirect } from '../shared/workflow-coordinator.mjs';

export class LocalWorkflowCoordinator {
  constructor(kv) {
    this.kv = kv;
    this.queues = new Map();
  }

  getByName(key) {
    return {
      fetch: async (_url, init = {}) => {
        let body;
        try {
          body = JSON.parse(String(init.body || '{}'));
        } catch {
          return Response.json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid coordinator body' } }, { status: 400 });
        }
        try {
          const mutation = await this.enqueue(key, () => commitWorkflowMutationDirect(this.kv, body));
          return Response.json({ ok: true, mutation });
        } catch (error) {
          return Response.json({
            ok: false,
            error: {
              code: String(error?.code || 'WORKFLOW_COORDINATOR_FAILED').slice(0, 120),
              message: String(error?.message || 'Workflow coordinator failed').slice(0, 1000)
            }
          }, { status: 500 });
        }
      }
    };
  }

  async enqueue(key, operation) {
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }
}
