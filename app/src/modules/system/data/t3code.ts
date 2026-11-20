import { loadT3Code, type T3CodeData } from '../../../lib/dashboard/t3code'

// The T3 Code tab reads one file the host stack writes, plus the project's
// release list. The reader lives in lib/dashboard beside the Claude one.
export type { T3CodeData }
export { loadT3Code }
