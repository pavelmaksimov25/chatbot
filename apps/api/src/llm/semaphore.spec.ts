import { QueueFullError, Semaphore } from './semaphore';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Semaphore', () => {
  it('admits up to the limit immediately and queues the rest', async () => {
    const semaphore = new Semaphore(2, 10);
    const a = await semaphore.acquire();
    await semaphore.acquire();

    let thirdAdmitted = false;
    const third = semaphore.acquire().then((release) => {
      thirdAdmitted = true;
      return release;
    });
    await tick();
    expect(semaphore.inFlight).toBe(2);
    expect(semaphore.queued).toBe(1);
    expect(thirdAdmitted).toBe(false);

    a(); // release one slot → the waiter is admitted
    await third;
    expect(thirdAdmitted).toBe(true);
    expect(semaphore.inFlight).toBe(2);
    expect(semaphore.queued).toBe(0);
  });

  it('admits waiters in FIFO order', async () => {
    const semaphore = new Semaphore(1, 10);
    const first = await semaphore.acquire();
    const order: number[] = [];
    const second = semaphore.acquire().then((r) => (order.push(2), r));
    const third = semaphore.acquire().then((r) => (order.push(3), r));

    first();
    (await second)();
    await third;
    expect(order).toEqual([2, 3]);
  });

  it('rejects with QueueFullError when the queue is at capacity', async () => {
    const semaphore = new Semaphore(1, 1);
    await semaphore.acquire();
    void semaphore.acquire(); // fills the single queue slot
    await expect(semaphore.acquire()).rejects.toBeInstanceOf(QueueFullError);
  });

  it('raising the limit admits queued waiters immediately', async () => {
    const semaphore = new Semaphore(1, 10);
    await semaphore.acquire();
    let admitted = false;
    void semaphore.acquire().then(() => (admitted = true));
    await tick();
    expect(admitted).toBe(false);

    semaphore.setLimit(2);
    await tick();
    expect(admitted).toBe(true);
  });

  it('lowering the limit drains naturally without revoking in-flight work', async () => {
    const semaphore = new Semaphore(2, 10);
    const a = await semaphore.acquire();
    const b = await semaphore.acquire();
    semaphore.setLimit(1);
    expect(semaphore.inFlight).toBe(2); // nothing revoked

    let admitted = false;
    void semaphore.acquire().then(() => (admitted = true));
    a();
    await tick();
    expect(admitted).toBe(false); // still at the new limit of 1
    b();
    await tick();
    expect(admitted).toBe(true);
  });

  it('tolerates double release without corrupting the count', async () => {
    const semaphore = new Semaphore(1, 10);
    const release = await semaphore.acquire();
    release();
    release();
    expect(semaphore.inFlight).toBe(0);
    await semaphore.acquire();
    expect(semaphore.inFlight).toBe(1);
  });

  it('never exceeds the limit under synthetic parallel load', async () => {
    const semaphore = new Semaphore(3, 100);
    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 25 }, async () => {
        const release = await semaphore.acquire();
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        await tick();
        inFlight -= 1;
        release();
      }),
    );

    expect(peak).toBe(3);
    expect(semaphore.inFlight).toBe(0);
  });
});
