import type { SidebarNavItem, WorkbenchLocale } from "./types";

export function getBuiltinSidebarNavItems(
  labels: WorkbenchLocale["labels"],
  scheduledTaskCount = 0,
  skillCount = 0,
): SidebarNavItem[] {
  return [
    {
      viewId: "chat",
      icon: "+",
      label: labels.newChat,
      group: "primary",
      order: 0,
    },
    {
      viewId: "automated",
      icon: "o",
      label: labels.automatedTasks,
      group: "primary",
      order: 1,
      badge: scheduledTaskCount,
    },
    {
      viewId: "skills",
      icon: "#",
      label: labels.skillMarket,
      group: "primary",
      order: 2,
      badge: skillCount,
    },
    {
      viewId: "apps",
      icon: "#",
      label: labels.apps,
      group: "knowledge",
      order: 0,
    },
    {
      viewId: "documents",
      icon: ">",
      label: labels.documents,
      group: "knowledge",
      order: 1,
      collapsible: true,
      subitems: [
        { label: labels.kbDocRecognition },
        { label: labels.kbCourseware },
        { label: labels.kbBooks },
        { label: labels.kbPapers },
      ],
    },
    {
      viewId: "gallery",
      icon: ">",
      label: labels.gallery,
      group: "knowledge",
      order: 2,
      collapsible: true,
      subitems: [
        { label: labels.kbImageRecognition },
        { label: labels.kbPeopleImpressions },
        { label: labels.kbFootprintLocations },
        { label: labels.kbTimelineGallery },
      ],
    },
    {
      viewId: "computer",
      icon: ">",
      label: labels.thisComputer,
      group: "knowledge",
      order: 3,
      collapsible: true,
      subitems: [
        { label: labels.kbSystemDrive, path: "C:\\" },
        { label: labels.kbDriveE, path: "E:\\" },
        { label: labels.kbDriveF, path: "F:\\" },
        { label: labels.kbDriveG, path: "G:\\" },
      ],
    },
  ];
}

/** Merge workspace-defined nav items into the built-in list, sorted by order within each group. */
export function mergeSidebarNavItems(
  builtin: SidebarNavItem[],
  custom: SidebarNavItem[] = [],
): SidebarNavItem[] {
  const merged = [...builtin];
  for (const item of custom) {
    const idx = merged.findIndex((b) => b.viewId === item.viewId);
    if (idx >= 0) {
      merged[idx] = item; // workspace overrides built-in
    } else {
      merged.push(item);
    }
  }
  // Sort by group order, then by order within group
  const groupOrder: Record<string, number> = { primary: 0, knowledge: 1, custom: 2 };
  merged.sort((a, b) => {
    const ga = groupOrder[a.group] ?? 99;
    const gb = groupOrder[b.group] ?? 99;
    if (ga !== gb) return ga - gb;
    return a.order - b.order;
  });
  return merged;
}
