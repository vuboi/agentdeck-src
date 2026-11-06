<script lang="ts">
    import {
        providerSources,
        SKILL_PROVIDER_IDS,
    } from '../../agents/models.svelte';
    import { isInstalled } from '../../agents/agent-status.svelte';
    import {
        connectorTargets,
        type ConnectorTarget,
        DEFAULT_AGENTS,
        isConnectorId,
        setConnectorList,
    } from '../../agents/connector-targets';
    import {
        assignSkill,
        store,
        type SkillItem,
    } from '../../store/store.svelte';
    import ProviderAccess from './ProviderAccess.svelte';

    let { skill }: { skill: SkillItem } = $props();
    const connectors = $derived(connectorTargets());

    /** A connector reads this skill by default when it is one of the Claude, Codex or Antigravity skills. */
    const byDefault = (item: SkillItem) =>
        item.agents.some((agent) => DEFAULT_AGENTS.includes(agent));

    /** A connector has the skill when it is in its own list, else by default. A restricted provider never has one. */
    function hasSkill(target: ConnectorTarget): boolean {
        if (target.restricted) return false;
        return target.provider.skills
            ? target.provider.skills.includes(skill.name)
            : byDefault(skill);
    }

    const options = $derived([
        ...providerSources(SKILL_PROVIDER_IDS.filter(isInstalled)).map(
            (source) => {
                const own =
                    skill.agents.includes(source.provider) &&
                    !skill.linked.includes(source.provider);
                return {
                    id: source.provider,
                    label: source.label,
                    disabled: own || skill.origin !== 'library',
                    hint: own ? 'Own copy' : undefined,
                };
            },
        ),
        ...connectors.map((target) => ({
            id: target.id,
            label: target.label,
            logo: target.logo,
            disabled: skill.origin !== 'library' || target.restricted,
            hint: target.restricted ? 'Not supported' : undefined,
        })),
    ]);
    const selected = $derived([
        ...skill.agents,
        ...connectors.filter(hasSkill).map((target) => target.id),
    ]);

    const sameSet = (a: string[], b: string[]) =>
        a.length === b.length && a.every((id) => b.includes(id));

    /** Save the latest queued selection: the CLI agents through the Store, each connector in its own list. */
    async function save(next: string[], initial: string[]) {
        const managed = (ids: string[]) =>
            ids.filter(
                (id) =>
                    !isConnectorId(id) &&
                    !options.find((o) => o.id === id)?.disabled,
            );
        let ok = true;
        if (!sameSet(managed(initial), managed(next))) {
            ok = (await assignSkill(skill.name, managed(next))) === 'ok';
        }
        const defaults = store.skills
            .filter(byDefault)
            .map((item) => item.name);
        for (const target of connectors) {
            const on = next.includes(target.id);
            if (on === initial.includes(target.id)) continue;
            const names = target.provider.skills ?? defaults;
            setConnectorList(
                target.provider,
                'skills',
                on
                    ? [...names, skill.name]
                    : names.filter((name) => name !== skill.name),
            );
        }
        return ok;
    }
</script>

<ProviderAccess name={skill.name} {selected} {options} onsave={save} />
