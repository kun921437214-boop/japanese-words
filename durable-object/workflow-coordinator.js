import { commitWorkflowMutationDirect } from '../shared/workflow-coordinator.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export class WorkflowCoordinator {
  constructor(_state, env) {
    this.env = env;
    this.writeQueue = Promise.resolve();
  }

  fetch(request) {
    const task = this.writeQueue.then(() => this.handleRequest(request));
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  async handleRequest(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/mutate') {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    }
    if (!this.env.FAVORITES) {
      return json({ ok: false, error: { code: 'STORAGE_NOT_CONFIGURED', message: 'Workflow KV binding is not configured' } }, 500);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } }, 400);
    }
    try {
      const mutation = await commitWorkflowMutationDirect(this.env.FAVORITES, body);
      return json({ ok: true, mutation });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'workflow_coordinator_error',
        errorName: String(error?.name || 'Error').slice(0, 120),
        errorCode: String(error?.code || '').slice(0, 120)
      }));
      return json({
        ok: false,
        error: {
          code: 'WORKFLOW_COORDINATOR_FAILED',
          message: 'Workflow mutation could not be committed'
        }
      }, 500);
    }
  }
}

export default {
  fetch() {
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  }
};
