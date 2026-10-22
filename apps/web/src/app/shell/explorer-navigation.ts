// How the explorer opens an entity or a page inside the shell (M1-42, R6): as a workspace tab. The feature asks
// its `EXPLORER_NAVIGATION` token; this is the shell's answer. A tab the shell refuses (the address or the label is
// too long, too many tabs) is not a reason to leave the person where they were: the address is shown anyway, and
// the shell's own notice says why there is no tab. The explorer is a lazy library the app never imports statically,
// so the token and the address function arrive as arguments.
import { inject, type InjectionToken, type Provider } from '@angular/core';
import { Router } from '@angular/router';

import { SHELL_LAYOUT_LIMITS } from './layout/shell-layout';
import { WorkspaceTabs } from './tabs/workspace-tabs';

/** A label the layout accepts: longer names are cut, with an ellipsis. */
export function tabLabel(label: string): string {
  const max = SHELL_LAYOUT_LIMITS.labelChars;
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

interface TabOpener {
  open(tab: { url: string; label: string }): string | null;
}

interface Navigator {
  navigateByUrl(url: string): Promise<boolean>;
}

/** The navigation object the explorer's token holds. */
export function createShellNavigation<T>(
  tabs: TabOpener,
  router: Navigator,
  urlOf: (cid: string, target: T) => string,
): {
  href: (cid: string, target: T) => string;
  open: (cid: string, target: T, label: string) => void;
} {
  return {
    href: urlOf,
    open: (cid, target, label) => {
      const url = urlOf(cid, target);
      const refusal = tabs.open({ url, label: tabLabel(label) });
      if (refusal !== null) void router.navigateByUrl(url);
    },
  };
}

/** Provides the explorer's navigation token with the shell's. */
export function provideShellNavigation(
  token: InjectionToken<unknown>,
  urlOf: (cid: string, target: never) => string,
): Provider {
  return {
    provide: token,
    useFactory: () =>
      createShellNavigation(inject(WorkspaceTabs), inject(Router), urlOf),
  };
}
