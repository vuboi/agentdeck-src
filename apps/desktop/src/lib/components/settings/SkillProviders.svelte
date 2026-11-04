<script lang="ts">
    import {
        providerSources,
        SKILL_PROVIDER_IDS,
    } from '../../agents/models.svelte';
    import { isInstalled } from '../../agents/agent-status.svelte';
    import { assignSkill, type SkillItem } from '../../store/store.svelte';
    import ProviderAccess from './ProviderAccess.svelte';

    let { skill }: { skill: SkillItem } = $props();
    const options = $derived(
        providerSources(SKILL_PROVIDER_IDS.filter(isInstalled)).map(
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
    );

    /** Save the latest queued selection, leaving independent provider copies untouched. */
    async function save(next: string[]) {
        const managed = next.filter(
            (id) => !options.find((o) => o.id === id)?.disabled,
        );
        return (await assignSkill(skill.name, managed)) === 'ok';
    }
</script>

<ProviderAccess
    name={skill.name}
    selected={skill.agents}
    {options}
    onsave={save}
/>
