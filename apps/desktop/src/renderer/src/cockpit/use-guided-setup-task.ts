import { useEffect, useRef, useState } from 'react';

export function useGuidedSetupTask(projectId: string) {
  const generation = useRef(0);
  const activeRef = useRef(false);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('No setup action is active.');

  useEffect(() => {
    generation.current += 1;
    activeRef.current = false;
    setActive(false);
    setStatus('Project changed. Setup results from the previous project are ignored.');
  }, [projectId]);

  const run = <T>(pending: string, work: () => Promise<T>, onSuccess: (value: T) => string) => {
    if (activeRef.current) return;
    const current = generation.current;
    activeRef.current = true;
    setActive(true);
    setStatus(pending);
    void Promise.resolve()
      .then(work)
      .then((value) => {
        if (current !== generation.current) return;
        setStatus(onSuccess(value));
      })
      .catch((error: unknown) => {
        if (current !== generation.current) return;
        setStatus(error instanceof Error ? error.message : 'Host setup action failed.');
      })
      .finally(() => {
        if (current === generation.current) {
          activeRef.current = false;
          setActive(false);
        }
      });
  };

  return { active, run, status };
}
