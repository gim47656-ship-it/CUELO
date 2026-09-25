// Minimal per-test Settings surface used by core harnesses.
// OMP 18.3.1 setting handles memoize reads through revision/valueCache and obtain raw
// configured values through rawValue; older cores only used the direct get function.
export function createSettingsTestScope(read: (key: string) => unknown) {
	// 18.3.1 `wait`는 launch.enabled(기본 true)면 project daemon에 서비스 목록을 묻는다.
	// harness는 daemon을 띄우지 않으므로 테스트가 따로 정하지 않으면 끈다.
	const get = (key: string) => {
		const value = read(key);
		return value === undefined && key === "launch.enabled" ? false : value;
	};
	return {
		revision: 0,
		valueCache: [] as ({ revision: number; inputs: readonly unknown[]; value: unknown } | undefined)[],
		warnState: { invalid: new Map<string, unknown>(), items: new Map<string, unknown>() },
		get,
		rawValue(setting: { id: string }) {
			return get(setting.id);
		},
		// 실제 Settings도 저장소가 없으면 null을 돌려준다(model usage/perf 기록을 건너뛴다).
		getStorage() {
			return null;
		},
	};
}

/**
 * 18.3.0식 흉내 객체(get/getGroup/getModelRole…)를 18.3.1 setting handle이 읽을 수 있게 감싼다.
 * 18.3.1은 retry.maxRetries처럼 개별 키로 읽으므로, get이 모르는 키는 getGroup(prefix)[rest]로 푼다.
 */
export function settingsLike<T extends { get: (key: string) => unknown; getGroup?: (group: string) => unknown }>(mock: T): T {
	const scope = createSettingsTestScope(key => {
		const value = mock.get(key);
		if (value !== undefined || !mock.getGroup) return value;
		const dot = key.indexOf(".");
		if (dot < 0) return undefined;
		const group = mock.getGroup(key.slice(0, dot)) as Record<string, unknown> | undefined;
		return group?.[key.slice(dot + 1)];
	});
	return Object.assign(Object.create(Object.getPrototypeOf(mock)), mock, scope) as T;
}
