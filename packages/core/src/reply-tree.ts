type Reply<T> = {
  id: string;
  parentId: string;
  byAuthor: boolean;
  value: T;
};

export class ReplyTree<T> {
  private readonly replies = new Map<string, Reply<T>>();
  private readonly byParent = new Map<string, Reply<T>[]>();

  constructor(private readonly rootId: string) {}

  add(reply: Reply<T>): boolean {
    if (reply.id === this.rootId || this.replies.has(reply.id)) return false;
    this.replies.set(reply.id, reply);
    const siblings = this.byParent.get(reply.parentId);
    if (siblings) siblings.push(reply);
    else this.byParent.set(reply.parentId, [reply]);
    return true;
  }

  children(parentId = this.rootId): readonly Reply<T>[] {
    return this.byParent.get(parentId) ?? [];
  }

  *authorReplies(): IterableIterator<Reply<T> & { depth: number }> {
    const queue = [{ id: this.rootId, depth: 0 }];
    for (const { id, depth } of queue) {
      for (const reply of this.children(id)) {
        if (!reply.byAuthor) continue;
        const child = { ...reply, depth: depth + 1 };
        queue.push(child);
        yield child;
      }
    }
  }

  *authorParents(): IterableIterator<string> {
    yield this.rootId;
    for (const { id } of this.authorReplies()) yield id;
  }

  select(limit: number): readonly Reply<T>[] {
    let deepest: (Reply<T> & { depth: number }) | undefined;
    for (const reply of this.authorReplies()) {
      if (!deepest || reply.depth > deepest.depth) deepest = reply;
    }
    if (!deepest) return this.children().slice(0, limit);

    const path: Reply<T>[] = [];
    for (let reply: Reply<T> | undefined = deepest; reply; reply = this.replies.get(reply.parentId)) {
      path.push(reply);
    }
    return path.reverse().slice(0, limit);
  }
}
