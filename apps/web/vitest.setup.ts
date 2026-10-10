/**
 * vitest 全局 setup：只挂 jest-dom 断言（toBeInTheDocument 等），
 * 纯逻辑测试不依赖它；组件测试将来可以直接用。
 */
import '@testing-library/jest-dom/vitest';
