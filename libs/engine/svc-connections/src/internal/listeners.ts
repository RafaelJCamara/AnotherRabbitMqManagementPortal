// AMQP ports from what the broker says it listens on (CON-01). `/api/overview` has a `listeners`
// array with one entry per node and protocol (`amqp`, `amqp/ssl`, `clustering`, `http`, ...). The
// profile form offers these instead of guessing 5672 and 5671.
export interface ListenerFact {
  readonly protocol: string;
  readonly port: number;
}

export interface AmqpPorts {
  readonly plain: number | null;
  readonly tls: number | null;
}

/**
 * The AMQP 0-9-1 ports among the listeners. A cluster lists the same port once per node, and a
 * node could listen on several: the most common port of each kind wins, the lowest on a tie, so the
 * answer does not depend on the order the nodes were listed in.
 */
export function amqpPortsFromListeners(
  listeners: readonly ListenerFact[],
): AmqpPorts {
  const pick = (protocol: string): number | null => {
    const counts = new Map<number, number>();
    for (const listener of listeners) {
      if (listener.protocol === protocol) {
        counts.set(listener.port, (counts.get(listener.port) ?? 0) + 1);
      }
    }
    let best: number | null = null;
    for (const [port, count] of counts) {
      const bestCount = best === null ? 0 : (counts.get(best) ?? 0);
      if (count > bestCount || (count === bestCount && port < (best ?? port))) {
        best = port;
      }
    }
    return best;
  };
  return { plain: pick('amqp'), tls: pick('amqp/ssl') };
}
