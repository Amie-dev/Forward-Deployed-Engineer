/**
 * Chapter 03 §3.3 — the data layer behind every primitive.
 *
 * The MCP layer never touches `tasks` directly. Tools *write* through the
 * mutating functions; Resources *read* through the view functions. One store,
 * two doors — which is exactly the Tools / Resources split of Chapter 02.
 */
export type Priority = "high" | "normal";

export type Task = {
  id: number;
  title: string;
  projectId: string;
  owner: string;
  priority: Priority;
  done: boolean;
};

const tasks: Task[] = [
  { id: 1, title: "Write MCP notes", projectId: "fde", owner: "123", priority: "high", done: false },
  { id: 2, title: "Review pull request", projectId: "fde", owner: "123", priority: "normal", done: false },
  { id: 3, title: "Record Lecture 15 video", projectId: "media", owner: "456", priority: "normal", done: false },
];

let nextId = tasks.length + 1;

/* ── writes — reached only through Tools (the model holds the trigger) ────── */

export function createTask(title: string): string {
  const task: Task = {
    id: nextId++,
    title,
    projectId: "inbox",
    owner: "123",
    priority: "normal",
    done: false,
  };

  tasks.push(task);

  return `Task created: ${task.title} (${task.priority} priority, project ${task.projectId})`;
}

export function completeTask(title: string): string {
  const task = tasks.find((candidate) => candidate.title === title && !candidate.done);

  // Chapter 08 — the failure path is written as a recovery instruction, because
  // this text goes straight back into the model's context.
  if (!task) {
    return `No pending task titled "${title}". Call list_tasks to read the exact titles, then retry.`;
  }

  task.done = true;

  return `Task completed: ${task.title}`;
}

/* ── reads — reached only through Resources (the application holds it) ────── */

export function listTasks(): Task[] {
  return tasks.map((task) => ({ ...task }));
}

export function openTasks(owner?: string): Task[] {
  return listTasks().filter((task) => !task.done && (owner === undefined || task.owner === owner));
}

/**
 * Chapter 04 — the DYNAMIC resource view: computed from the store on every
 * read, so it is never stale.
 */
export function backlogText(owner?: string): string {
  const open = openTasks(owner);

  if (open.length === 0) {
    return "No open tasks.";
  }

  const lines = open.map(
    (task) => `- [${task.priority}] ${task.title}  (project: ${task.projectId}, owner: ${task.owner})`,
  );

  return [`Open tasks: ${open.length}`, "", ...lines].join("\n");
}

export function summaryText(owner?: string): string {
  const open = openTasks(owner);
  const high = open.filter((task) => task.priority === "high").length;
  const projects = [...new Set(open.map((task) => task.projectId))];

  return [
    `Open tasks: ${open.length}`,
    `High priority: ${high}`,
    `Normal priority: ${open.length - high}`,
    `Projects involved: ${projects.join(", ") || "none"}`,
  ].join("\n");
}

/** Chapter 04 — the view behind the TEMPLATED resource `task://projects/{projectId}`. */
export function projectText(projectId: string): string {
  const inProject = listTasks().filter((task) => task.projectId === projectId);

  if (inProject.length === 0) {
    return `No tasks in project "${projectId}".`;
  }

  const lines = inProject.map((task) => `- ${task.done ? "[done]" : "[open]"} ${task.title}`);

  return [`Project: ${projectId}`, `Tasks: ${inProject.length}`, "", ...lines].join("\n");
}

/** Chapter 04 — the view behind the TEMPLATED resource `user://{userId}/profile`. */
export function profileText(userId: string): string {
  const owned = listTasks().filter((task) => task.owner === userId);
  const open = owned.filter((task) => !task.done);

  if (owned.length === 0) {
    return `No profile found for user "${userId}".`;
  }

  return [
    `User: ${userId}`,
    `Open tasks: ${open.length} of ${owned.length}`,
    "",
    ...owned.map((task) => `- ${task.done ? "[done]" : "[open]"} ${task.title}`),
  ].join("\n");
}
